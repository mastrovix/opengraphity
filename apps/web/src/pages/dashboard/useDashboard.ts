import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { errorMessage } from '@/hooks/useMutationWithToast'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import {
  GET_MY_DASHBOARDS,
  GET_DASHBOARD,
  GET_REPORT_TEMPLATES,
  GET_TEAMS,
} from '@/graphql/queries'
import {
  SAVE_DASHBOARD_LAYOUT,
  DELETE_CUSTOM_WIDGET,
} from '@/graphql/mutations'
import type { PendingWidget } from './DashboardEditMode'
import type { CustomWidgetData } from './CustomWidgetCard'
import { showError } from '@/lib/showError'

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
  reportTemplate: { id: string; name: string; description?: string | null } | null
}

export interface DashboardConfig {
  id: string
  name: string
  description: string | null
  role: string | null
  isDefault: boolean
  isPersonal: boolean
  isShared: boolean
  visibility: string
  createdAt: string
  createdBy: { id: string; name: string } | null
  sharedWith: Team[]
  widgets: DashboardWidgetServer[]
  customWidgets: CustomWidgetData[]
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
  const { t, i18n } = useTranslation()
  // V-20: le etichette dei valori nei widget seguono la lingua di chi guarda
  const language = i18n.resolvedLanguage ?? i18n.language
  const [activeDashboardId, setActiveDashboardId] = useState<string | null>(null)
  const [editMode, setEditMode]                   = useState(false)
  const [pendingWidgets, setPendingWidgets]        = useState<PendingWidget[]>([])
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(new Set())
  const [saving, setSaving]                       = useState(false)
  const [showCreate, setShowCreate]               = useState(false)
  const [showSettings, setShowSettings]           = useState(false)
  const [dropdownOpen, setDropdownOpen]           = useState(false)
  // Custom widget state
  const [customWidgets, setCustomWidgets]         = useState<CustomWidgetData[]>([])

  const { data: listData, loading: listLoading, refetch: refetchList } =
    useQuery<{ myDashboards: DashboardConfig[] }>(GET_MY_DASHBOARDS)

  const { data: dashData, loading: dashLoading, refetch: refetchDash } =
    useQuery<{ dashboard: DashboardConfig | null }>(GET_DASHBOARD, {
      variables: { id: activeDashboardId, language },
      skip: !activeDashboardId,
    })

  const { data: templatesData } = useQuery<{ reportTemplates: ReportTemplate[] }>(GET_REPORT_TEMPLATES)
  const { data: teamsData }     = useQuery<{ teams: Team[] }>(GET_TEAMS)

  const dashboards = useMemo(() => listData?.myDashboards ?? [], [listData])
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

  // Sync custom widgets from server
  useEffect(() => {
    if (activeDash?.customWidgets) {
      setCustomWidgets(activeDash.customWidgets)
    }
  }, [activeDash?.customWidgets])

  const [saveLayoutMutation]          = useMutation<{ saveDashboardLayout: { id: string; widgets: DashboardWidgetServer[] } }>(SAVE_DASHBOARD_LAYOUT)
  const [deleteCustomWidgetMutation]  = useMutation(DELETE_CUSTOM_WIDGET)

  function enterEditMode() {
    if (activeDash?.widgets) setPendingWidgets(activeDash.widgets.map(serverWidgetToPending))
    setEditMode(true)
  }

  /**
   * Cancel throws away only what waits for Save: the arrangement of the report
   * widgets. Custom widgets are created, edited and deleted on the server at
   * once, so they are left as they are — resetting them to the dashboard as it
   * was LOADED brought a deleted widget back and dropped a new one (tour of
   * 23 Sep 2026).
   */
  function cancelEditMode() {
    if (activeDash?.widgets) setPendingWidgets(activeDash.widgets.map(serverWidgetToPending))
    setEditMode(false)
  }

  /**
   * After the dashboard on screen is deleted, another one is opened at once,
   * chosen among those that REMAIN: the default, else the first (tour of 23 Sep
   * 2026). Clearing the selection left the choice to the auto-selection, which
   * ran on the list still on screen — the deleted dashboard was in it and, when
   * it was the default, was chosen again: the selector read "…".
   */
  function handleDashboardDeleted(deletedId: string) {
    const remaining = dashboards.filter((d) => d.id !== deletedId)
    setActiveDashboardId((remaining.find((d) => d.isDefault) ?? remaining[0])?.id ?? null)
    void refetchList()
  }

  // ── Custom widget handlers ───────────────────────────────────────────────────

  function handleWidgetSaved(saved: CustomWidgetData) {
    setCustomWidgets((prev) => {
      const idx = prev.findIndex((w) => w.id === saved.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = saved
        return next
      }
      return [...prev, saved]
    })
  }

  async function handleDeleteCustomWidget(widgetId: string) {
    try {
      await deleteCustomWidgetMutation({ variables: { id: widgetId } })
      setCustomWidgets((prev) => prev.filter((w) => w.id !== widgetId))
      toast.success(t('toast.widget.removed'))
    } catch (err: unknown) {
      showError(err, t('toast.widget.removeFailed', { error: errorMessage(err) }))
    }
  }

  /**
   * F-08: ONE atomic mutation with the desired layout (order = list order).
   * Deleted widgets are simply omitted; entries without `id` are created.
   * On error nothing was persisted, so the pending state (isNew included) is
   * still accurate and the user can retry; on success the state is rebuilt
   * from the server result, never from optimistic guesses.
   */
  async function handleSave() {
    if (!activeDashboardId) return
    setSaving(true)
    try {
      const layout = pendingWidgets
        .filter((w) => !w.isDeleted)
        .map((w) => ({
          id:               w.isNew ? null : (w.serverId ?? null),
          reportTemplateId: w.reportTemplateId,
          reportSectionId:  w.reportSectionId,
          colSpan:          w.colSpan,
        }))

      const result = await saveLayoutMutation({ variables: { dashboardId: activeDashboardId, widgets: layout, language } })
      const saved = result.data?.saveDashboardLayout
      if (!saved) throw new Error(t('toast.dashboard.emptyResponse'))

      setPendingWidgets(saved.widgets.map(serverWidgetToPending))
      setEditMode(false)
      toast.success(t('toast.dashboard.saved'))
    } catch (err: unknown) {
      // Atomic on the server: nothing was applied. Stay in edit mode with the
      // untouched pending layout so a retry does not duplicate anything.
      showError(err, t('toast.dashboard.saveFailed', { error: errorMessage(err) }))
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
    customWidgets,
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
    handleDashboardDeleted,
    handleWidgetSaved,
    handleDeleteCustomWidget,
  }
}
