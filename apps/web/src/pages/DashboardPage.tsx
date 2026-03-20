import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GET_MY_DASHBOARDS,
  GET_DASHBOARD,
  GET_REPORT_TEMPLATES,
  GET_TEAMS,
} from '@/graphql/queries'
import {
  CREATE_DASHBOARD,
  UPDATE_DASHBOARD,
  DELETE_DASHBOARD,
  ADD_DASHBOARD_WIDGET,
  REMOVE_DASHBOARD_WIDGET,
  REORDER_DASHBOARD_WIDGETS,
  UPDATE_DASHBOARD_WIDGET,
} from '@/graphql/mutations'
import { ReportChartRenderer } from '@/components/ReportChartRenderer'

// ── Types ────────────────────────────────────────────────────────────────────

interface Team {
  id: string
  name: string
}

interface ReportSection {
  id: string
  title: string
  chartType: string
  order: number
}

interface ReportTemplate {
  id: string
  name: string
  sections: ReportSection[]
}

interface DashboardWidget {
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

interface DashboardConfig {
  id: string
  name: string
  isDefault: boolean
  isPersonal: boolean
  visibility: string
  createdAt: string
  createdBy: { id: string; name: string } | null
  sharedWith: Team[]
  widgets: DashboardWidget[]
}

interface PendingWidget {
  tempId: string
  serverId?: string
  reportTemplateId: string
  reportSectionId: string
  colSpan: number
  order: number
  reportSection: { id: string; title: string; chartType: string } | null
  reportTemplate: { id: string; name: string } | null
  data: string | null
  isNew: boolean
  isDeleted: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function serverWidgetToPending(w: DashboardWidget, idx: number): PendingWidget {
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

// ── SortableItem ─────────────────────────────────────────────────────────────

interface SortableItemProps {
  widget: PendingWidget
  onRemove: (tempId: string) => void
  onUpdateColSpan: (tempId: string, colSpan: number) => void
}

function SortableItem({ widget, onRemove, onUpdateColSpan }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: widget.tempId })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    gridColumn: `span ${widget.colSpan}`,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div style={{
        border: '2px dashed #818cf8',
        borderRadius: 10,
        background: '#fff',
        overflow: 'hidden',
        position: 'relative',
      }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            {...listeners}
            style={{ cursor: 'grab', fontSize: 16, color: '#9ca3af', userSelect: 'none', lineHeight: 1 }}
            title="Trascina per riordinare"
          >
            ⠿
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {widget.reportSection?.title ?? 'Widget'}
              {widget.isNew && (
                <span style={{ marginLeft: 6, fontSize: 10, color: '#6366f1', fontWeight: 400 }}>nuovo</span>
              )}
            </div>
            {widget.reportTemplate?.name && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{widget.reportTemplate.name}</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select
              value={widget.colSpan}
              onChange={(e) => onUpdateColSpan(widget.tempId, Number(e.target.value))}
              style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' }}
            >
              {[2, 3, 4, 6, 12].map((s) => (
                <option key={s} value={s}>{s} col</option>
              ))}
            </select>
            <button
              onClick={() => onRemove(widget.tempId)}
              style={{
                width: 20, height: 20, borderRadius: 4, border: '1px solid #fca5a5',
                background: '#fef2f2', color: '#ef4444', fontSize: 12, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
              }}
            >
              ×
            </button>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <ReportChartRenderer
            chartType={widget.reportSection?.chartType ?? 'bar'}
            data={widget.data ?? ''}
            title={widget.reportSection?.title ?? ''}
            error={null}
          />
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', background: 'rgba(255,255,255,0.4)' }} />
        </div>
      </div>
    </div>
  )
}

// ── CreateDashboardDialog ──────────────────────────────────────────────────────

interface CreateDashboardDialogProps {
  teams: Team[]
  onClose: () => void
  onCreated: (id: string) => void
}

function CreateDashboardDialog({ teams, onClose, onCreated }: CreateDashboardDialogProps) {
  const [name, setName]                 = useState('')
  const [visibility, setVisibility]     = useState('private')
  const [selectedTeams, setSelectedTeams] = useState<string[]>([])
  const [creating, setCreating]         = useState(false)

  const [createDashboard] = useMutation(CREATE_DASHBOARD)

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    try {
      const result = await createDashboard({
        variables: {
          input: {
            name: name.trim(),
            visibility,
            sharedWithTeamIds: visibility === 'teams' ? selectedTeams : [],
          },
        },
      })
      const created = (result.data as { createDashboard: DashboardConfig }).createDashboard
      toast.success('Dashboard creata')
      onCreated(created.id)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Errore')
    } finally {
      setCreating(false)
    }
  }

  function toggleTeam(id: string) {
    setSelectedTeams((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 16 }}>Nuova dashboard</h2>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Nome</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Es. Operations Overview"
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
        />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Visibilità</label>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 12 }}
        >
          <option value="private">Privata (solo io)</option>
          <option value="teams">Condivisa con team</option>
          <option value="all">Tutti nel tenant</option>
        </select>

        {visibility === 'teams' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Team</label>
            <div style={{ border: '1px solid #d1d5db', borderRadius: 6, maxHeight: 120, overflowY: 'auto' }}>
              {teams.map((t) => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}>
                  <input
                    type="checkbox"
                    checked={selectedTeams.includes(t.id)}
                    onChange={() => toggleTeam(t.id)}
                    style={{ margin: 0 }}
                  />
                  <span style={{ fontSize: 12, color: '#374151' }}>{t.name}</span>
                </label>
              ))}
              {teams.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: '#9ca3af' }}>Nessun team</div>}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer' }}>
            Annulla
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim()}
            style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: creating || !name.trim() ? '#a5b4fc' : '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: creating || !name.trim() ? 'not-allowed' : 'pointer' }}
          >
            {creating ? 'Creazione…' : 'Crea'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── SettingsDialog ─────────────────────────────────────────────────────────────

interface SettingsDialogProps {
  dashboard: DashboardConfig
  teams: Team[]
  canDelete: boolean
  onClose: () => void
  onDeleted: () => void
  onUpdated: () => void
}

function SettingsDialog({ dashboard, teams, canDelete, onClose, onDeleted, onUpdated }: SettingsDialogProps) {
  const [name, setName]                 = useState(dashboard.name)
  const [visibility, setVisibility]     = useState(dashboard.visibility)
  const [selectedTeams, setSelectedTeams] = useState<string[]>(dashboard.sharedWith.map((t) => t.id))
  const [saving, setSaving]             = useState(false)
  const [deleting, setDeleting]         = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [updateDashboard] = useMutation(UPDATE_DASHBOARD)
  const [deleteDashboard] = useMutation(DELETE_DASHBOARD)

  async function handleSave() {
    setSaving(true)
    try {
      await updateDashboard({
        variables: {
          id: dashboard.id,
          input: {
            name: name.trim() || dashboard.name,
            visibility,
            sharedWithTeamIds: visibility === 'teams' ? selectedTeams : [],
          },
        },
      })
      toast.success('Dashboard aggiornata')
      onUpdated()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Errore')
    } finally {
      setSaving(false)
    }
  }

  async function handleSetDefault() {
    try {
      await updateDashboard({ variables: { id: dashboard.id, input: { isDefault: true } } })
      toast.success('Dashboard impostata come default')
      onUpdated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Errore')
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteDashboard({ variables: { id: dashboard.id } })
      toast.success('Dashboard eliminata')
      onDeleted()
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Errore')
    } finally {
      setDeleting(false)
    }
  }

  function toggleTeam(id: string) {
    setSelectedTeams((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 16 }}>Impostazioni dashboard</h2>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Nome</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }}
        />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Visibilità</label>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, marginBottom: 12 }}
        >
          <option value="private">Privata (solo io)</option>
          <option value="teams">Condivisa con team</option>
          <option value="all">Tutti nel tenant</option>
        </select>

        {visibility === 'teams' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Team</label>
            <div style={{ border: '1px solid #d1d5db', borderRadius: 6, maxHeight: 120, overflowY: 'auto' }}>
              {teams.map((t) => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}>
                  <input
                    type="checkbox"
                    checked={selectedTeams.includes(t.id)}
                    onChange={() => toggleTeam(t.id)}
                    style={{ margin: 0 }}
                  />
                  <span style={{ fontSize: 12, color: '#374151' }}>{t.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {!dashboard.isDefault && (
          <button
            onClick={() => void handleSetDefault()}
            style={{ width: '100%', padding: '7px 14px', borderRadius: 6, border: '1px solid #6366f1', background: '#eef2ff', color: '#6366f1', fontSize: 13, fontWeight: 500, cursor: 'pointer', marginBottom: 8 }}
          >
            ★ Imposta come default
          </button>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 8 }}>
          <div>
            {canDelete && !confirmDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fef2f2', color: '#ef4444', fontSize: 13, cursor: 'pointer' }}
              >
                Elimina
              </button>
            )}
            {confirmDelete && (
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: '#ef4444', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                {deleting ? 'Eliminazione…' : 'Conferma eliminazione'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer' }}>
              Annulla
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: saving ? '#a5b4fc' : '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}
            >
              {saving ? 'Salvataggio…' : 'Salva'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── DashboardPage ─────────────────────────────────────────────────────────────

export function DashboardPage() {
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

  const [addWidgetMutation]     = useMutation(ADD_DASHBOARD_WIDGET)
  const [removeWidgetMutation]  = useMutation(REMOVE_DASHBOARD_WIDGET)
  const [reorderWidgetsMutation] = useMutation(REORDER_DASHBOARD_WIDGETS)
  const [updateWidgetMutation]  = useMutation(UPDATE_DASHBOARD_WIDGET)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const visiblePending = pendingWidgets.filter((w) => !w.isDeleted)

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

  const activeDashName = dashboards.find((d) => d.id === activeDashboardId)?.name ?? '…'

  // ── Header ──────────────────────────────────────────────────────────────────

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', letterSpacing: '-0.01em', margin: 0 }}>Dashboard</h1>

        {/* Dashboard selector dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 10px', borderRadius: 6, border: '1px solid #d1d5db',
              background: '#fff', color: '#374151', fontSize: 13, fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <span>{activeDashName}</span>
            <span style={{ fontSize: 10, color: '#9ca3af' }}>▼</span>
          </button>

          {dropdownOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4,
              background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
              boxShadow: '0 4px 16px rgba(0,0,0,0.1)', minWidth: 220, zIndex: 100,
            }}>
              {dashboards.map((d) => (
                <button
                  key={d.id}
                  onClick={() => handleSelectDashboard(d.id)}
                  style={{
                    width: '100%', padding: '8px 12px', textAlign: 'left',
                    background: d.id === activeDashboardId ? '#f0f9ff' : 'none',
                    border: 'none', cursor: 'pointer', fontSize: 13,
                    color: d.id === activeDashboardId ? '#0369a1' : '#374151',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  {d.isDefault && <span style={{ fontSize: 10, color: '#f59e0b' }}>★</span>}
                  <span>{d.name}</span>
                  {d.visibility !== 'private' && (
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9ca3af' }}>
                      {d.visibility === 'all' ? 'tutti' : 'team'}
                    </span>
                  )}
                </button>
              ))}
              <div style={{ borderTop: '1px solid #f3f4f6', padding: 4 }}>
                <button
                  onClick={() => { setDropdownOpen(false); setShowCreate(true) }}
                  style={{
                    width: '100%', padding: '7px 12px', textAlign: 'left',
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 13, color: '#6366f1', fontWeight: 500,
                  }}
                >
                  + Nuova dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {editMode ? (
          <>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #6366f1', background: saving ? '#a5b4fc' : '#6366f1', color: '#fff', fontSize: 13, fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer' }}
            >
              {saving ? 'Salvataggio…' : '✓ Salva'}
            </button>
            <button
              onClick={cancelEditMode}
              disabled={saving}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              ✕ Annulla
            </button>
          </>
        ) : (
          <>
            <button
              onClick={enterEditMode}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              ✏ Personalizza
            </button>
            <button
              onClick={() => setShowSettings(true)}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              ⚙ Impostazioni
            </button>
          </>
        )}
      </div>
    </div>
  )

  // ── Loading ──────────────────────────────────────────────────────────────────

  if (listLoading || (activeDashboardId && dashLoading && !dashData)) {
    return <div style={{ padding: 32, color: '#6b7280', fontSize: 14 }}>Caricamento…</div>
  }

  // ── VIEW MODE ────────────────────────────────────────────────────────────────

  if (!editMode) {
    const viewWidgets = activeDash?.widgets ?? []
    return (
      <div>
        {header}
        {viewWidgets.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#8892a4', fontSize: 14 }}>
            La dashboard è vuota. Clicca <strong>Personalizza</strong> per aggiungere i tuoi report.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16, padding: 24 }}>
            {viewWidgets.map((widget) => (
              <div key={widget.id} style={{ gridColumn: `span ${widget.colSpan}` }}>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      {widget.reportSection?.title ?? 'Widget'}
                    </div>
                    {widget.reportTemplate?.name && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{widget.reportTemplate.name}</div>
                    )}
                  </div>
                  <ReportChartRenderer
                    chartType={widget.reportSection?.chartType ?? 'bar'}
                    data={widget.data ?? ''}
                    title={widget.reportSection?.title ?? ''}
                    error={widget.error}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {showCreate && (
          <CreateDashboardDialog
            teams={teams}
            onClose={() => setShowCreate(false)}
            onCreated={(id) => {
              setShowCreate(false)
              void refetchList().then(() => setActiveDashboardId(id))
            }}
          />
        )}
        {showSettings && activeDash && (
          <SettingsDialog
            dashboard={activeDash}
            teams={teams}
            canDelete={dashboards.length > 1}
            onClose={() => setShowSettings(false)}
            onDeleted={() => {
              setActiveDashboardId(null)
              void refetchList()
            }}
            onUpdated={() => {
              void refetchList()
              void refetchDash()
            }}
          />
        )}
      </div>
    )
  }

  // ── EDIT MODE ────────────────────────────────────────────────────────────────

  return (
    <div>
      {header}
      <div style={{ display: 'flex', gap: 16, padding: 24, alignItems: 'flex-start' }}>
        {/* Draggable grid */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {visiblePending.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#8892a4', fontSize: 14, border: '2px dashed #e5e7eb', borderRadius: 10 }}>
              Nessun widget. Aggiungi un report dal pannello a destra.
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visiblePending.map((w) => w.tempId)} strategy={rectSortingStrategy}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16 }}>
                  {visiblePending.map((widget) => (
                    <SortableItem
                      key={widget.tempId}
                      widget={widget}
                      onRemove={handleRemoveWidget}
                      onUpdateColSpan={handleUpdateColSpan}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Add widget sidebar */}
        <div style={{ width: 280, flexShrink: 0, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #f3f4f6', fontSize: 13, fontWeight: 600, color: '#374151' }}>
            Aggiungi widget
          </div>
          <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
            {templates.length === 0 && (
              <div style={{ padding: 16, fontSize: 12, color: '#9ca3af' }}>Nessun template disponibile.</div>
            )}
            {templates.map((template) => (
              <div key={template.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <button
                  onClick={() => toggleTemplate(template.id)}
                  style={{
                    width: '100%', padding: '10px 14px', display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', background: 'none', border: 'none',
                    cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#374151', textAlign: 'left',
                  }}
                >
                  <span>{template.name}</span>
                  <span style={{ color: '#9ca3af', fontSize: 10 }}>{expandedTemplates.has(template.id) ? '▲' : '▼'}</span>
                </button>
                {expandedTemplates.has(template.id) && (
                  <div style={{ background: '#f9fafb', paddingBottom: 4 }}>
                    {(template.sections ?? []).length === 0 && (
                      <div style={{ padding: '6px 14px', fontSize: 11, color: '#9ca3af' }}>Nessuna sezione</div>
                    )}
                    {(template.sections ?? []).map((section) => (
                      <div key={section.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', gap: 8 }}>
                        <span style={{ fontSize: 11, color: '#4b5563', flex: 1, minWidth: 0 }}>{section.title}</span>
                        <button
                          onClick={() => handleAddWidget(template, section)}
                          style={{
                            padding: '3px 8px', borderRadius: 4, border: '1px solid #6366f1',
                            background: '#eef2ff', color: '#6366f1', fontSize: 11, fontWeight: 600,
                            cursor: 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          + Aggiungi
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default DashboardPage
