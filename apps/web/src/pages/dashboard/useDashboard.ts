import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import {
  GET_MY_DASHBOARDS,
  GET_DASHBOARD,
  GET_REPORT_TEMPLATES,
  GET_TEAMS,
} from '@/graphql/queries'
import {
  ADD_DASHBOARD_WIDGET,
  REMOVE_DASHBOARD_WIDGET,
  REORDER_DASHBOARD_WIDGETS,
  UPDATE_DASHBOARD_WIDGET,
} from '@/graphql/mutations'
import type { PendingWidget } from './DashboardEditMode'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Team {
  id: string
  name: string
}

export interface ReportSection {
  id: string
  title: string
  chartType: string
  order: number
}

export interface ReportTemplate {
  id: string
  name: string
  sections: ReportSection[]
}

export interface DashboardWidgetServer {
  id: string
  order: number
  colSpan: number
  reportTemplateId: string
  reportSectionId: string
  data: string | null
  error: string | null
  reportSection: { id: string; title: string; chartType: string } | null
  reportTemplate: { id: string; name: string } | null
}

export interface DashboardConfig {
  id: string
  name: string
  isDefault: boolean
  isPersonal: boolean
  visibility: string
  createdAt: string
  createdBy: { id: string; name: string } | null
  sharedWith: Team[]
  widgets: DashboardWidgetServer[]
}

// ── Helper ────────────────────────────────────────────────────────────────────

function serverWidgetToPending(w: DashboardWidgetServer, idx: number): PendingWidget {
  return {
    tempId:           w.id,
    serverId:         w.id,
    reportTemplateId: w.reportTemplateId,
    reportSectionId:  w.reportSectionId,
    colSpan:          w.colSpan,
    order:            idx,
    reportSection:    w.reportSection,
    reportTemplate:   w.reportTemplate,
    data:             w.data,
    isNew:            false,
    isDeleted:        false,
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboard() {
  const [activeDashboardId, setActiveDashboardId] = useState<string | null>(null)
  const [editMode, setEditMode]                   = useState(false)
  const [pendingWidgets, setPendingWidgets]        = useState<PendingWidget[]>([])
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(new Set())
  const [saving, setSaving]                       = useState(false)
  const [showCreate, setShowCreate]               = useState(false)
  const [showSettings, setShowSettings]           = useState(false)
  const [dropdownOpen, setDropdownOpen]           = useState(false)

  const { data: listData, loading: listLoading, refetch: refetchList } =
    useQuery<{ myDashboards: DashboardConfig[] }>(GET_MY_DASHBOARDS)

  const { data: dashData, loading: dashLoading, refetch: refetchDash } =
    useQuery<{ dashboard: DashboardConfig | null }>(GET_DASHBOARD, {
      variables: { id: activeDashboardId },
      skip: !activeDashboardId,
    })

  const { data: templatesData } = useQuery<{ reportTemplates: ReportTemplate[] }>(GET_REPORT_TEMPLATES)
  const { data: teamsData }     = useQuery<{ teams: Team[] }>(GET_TEAMS)

  const dashboards = listData?.myDashboards ?? []
  const activeDash = dashData?.dashboard ?? null
  const templates  = templatesData?.reportTemplates ?? []
  const teams      = teamsData?.teams ?? []

  // Auto-select default dashboard on first load
  useEffect(() => {
    if (!activeDashboardId && dashboards.length > 0) {
      const def = dashboards.find((d) => d.isDefault) ?? dashboards[0]
      setActiveDashboardId(def.id)
    }
  }, [dashboards, activeDashboardId])

  // Sync pending widgets when dashboard data loads (outside edit mode)
  useEffect(() => {
    if (!editMode && activeDash?.widgets) {
      setPendingWidgets(activeDash.widgets.map(serverWidgetToPending))
    }
  }, [activeDash?.widgets, editMode])

  const [addWidgetMutation]      = useMutation(ADD_DASHBOARD_WIDGET)
  const [removeWidgetMutation]   = useMutation(REMOVE_DASHBOARD_WIDGET)
  const [reorderWidgetsMutation] = useMutation(REORDER_DASHBOARD_WIDGETS)
  const [updateWidgetMutation]   = useMutation(UPDATE_DASHBOARD_WIDGET)

  function enterEditMode() {
    if (activeDash?.widgets) setPendingWidgets(activeDash.widgets.map(serverWidgetToPending))
    setEditMode(true)
  }

  function cancelEditMode() {
    if (activeDash?.widgets) setPendingWidgets(activeDash.widgets.map(serverWidgetToPending))
    setEditMode(false)
  }

  async function handleSave() {
    if (!activeDashboardId) return
    setSaving(true)
    try {
      // 1. Add new widgets
      for (const w of pendingWidgets.filter((w) => w.isNew && !w.isDeleted)) {
        await addWidgetMutation({
          variables: { input: { dashboardId: activeDashboardId, reportTemplateId: w.reportTemplateId, reportSectionId: w.reportSectionId, colSpan: w.colSpan } },
        })
      }

      // 2. Remove deleted existing widgets
      for (const w of pendingWidgets.filter((w) => w.isDeleted && !w.isNew && w.serverId)) {
        await removeWidgetMutation({ variables: { widgetId: w.serverId } })
      }

      // 3. Update colSpan for changed existing widgets
      const serverWidgets = activeDash?.widgets ?? []
      for (const pw of pendingWidgets.filter((w) => !w.isNew && !w.isDeleted && w.serverId)) {
        const original = serverWidgets.find((sw) => sw.id === pw.serverId)
        if (original && original.colSpan !== pw.colSpan) {
          await updateWidgetMutation({ variables: { widgetId: pw.serverId, input: { colSpan: pw.colSpan } } })
        }
      }

      // 4. Reorder existing widgets
      const existingIds = pendingWidgets
        .filter((w) => !w.isNew && !w.isDeleted && w.serverId)
        .map((w) => w.serverId as string)
      if (existingIds.length > 1) {
        await reorderWidgetsMutation({ variables: { dashboardId: activeDashboardId, widgetIds: existingIds } })
      }

      await refetchDash()
      setEditMode(false)
      toast.success('Dashboard salvata')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Errore durante il salvataggio')
    } finally {
      setSaving(false)
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setPendingWidgets((prev) => {
        const visibleIds = prev.filter((w) => !w.isDeleted).map((w) => w.tempId)
        const oldIdx = visibleIds.indexOf(active.id as string)
        const newIdx = visibleIds.indexOf(over.id as string)
        const reorderedVisible = arrayMove(visibleIds, oldIdx, newIdx)
        const deleted = prev.filter((w) => w.isDeleted)
        const reordered = reorderedVisible.map((tid) => prev.find((w) => w.tempId === tid)!)
        return [...reordered, ...deleted]
      })
    }
  }

  function handleRemoveWidget(tempId: string) {
    setPendingWidgets((prev) =>
      prev
        .map((w) => w.tempId !== tempId ? w : { ...w, isDeleted: true })
        .filter((w) => !(w.isNew && w.isDeleted)),
    )
  }

  function handleUpdateColSpan(tempId: string, colSpan: number) {
    setPendingWidgets((prev) => prev.map((w) => w.tempId === tempId ? { ...w, colSpan } : w))
  }

  function handleAddWidget(template: ReportTemplate, section: ReportSection) {
    const visiblePending = pendingWidgets.filter((w) => !w.isDeleted)
    const newWidget: PendingWidget = {
      tempId:           `temp-${Date.now()}`,
      reportTemplateId: template.id,
      reportSectionId:  section.id,
      colSpan:          4,
      order:            visiblePending.length,
      reportSection:    { id: section.id, title: section.title, chartType: section.chartType },
      reportTemplate:   { id: template.id, name: template.name },
      data:             null,
      isNew:            true,
      isDeleted:        false,
    }
    setPendingWidgets((prev) => [...prev, newWidget])
  }

  function toggleTemplate(templateId: string) {
    setExpandedTemplates((prev) => {
      const next = new Set(prev)
      if (next.has(templateId)) next.delete(templateId); else next.add(templateId)
      return next
    })
  }

  function handleSelectDashboard(id: string) {
    setActiveDashboardId(id)
    setDropdownOpen(false)
    setEditMode(false)
  }

  return {
    // State
    activeDashboardId,
    editMode,
    pendingWidgets,
    expandedTemplates,
    saving,
    showCreate,
    showSettings,
    dropdownOpen,
    // Data
    dashboards,
    activeDash,
    templates,
    teams,
    listLoading,
    dashLoading,
    dashData,
    // Derived
    activeDashName: dashboards.find((d) => d.id === activeDashboardId)?.name ?? '…',
    // Setters
    setActiveDashboardId,
    setShowCreate,
    setShowSettings,
    setDropdownOpen,
    refetchList,
    refetchDash,
    // Handlers
    enterEditMode,
    cancelEditMode,
    handleSave,
    handleDragEnd,
    handleRemoveWidget,
    handleUpdateColSpan,
    handleAddWidget,
    toggleTemplate,
    handleSelectDashboard,
  }
}
