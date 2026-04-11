import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { toast } from 'sonner'
import { LayoutDashboard } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import {
  CREATE_DASHBOARD,
  UPDATE_DASHBOARD,
  DELETE_DASHBOARD,
} from '@/graphql/mutations'
import { DashboardWidget } from './dashboard/DashboardWidget'
import { DashboardEditMode } from './dashboard/DashboardEditMode'
import { CustomWidgetCard } from './dashboard/CustomWidgetCard'
import { WidgetConfigPanel } from './dashboard/WidgetConfigPanel'
import { useDashboard } from './dashboard/useDashboard'
import type { DashboardConfig, Team } from './dashboard/useDashboard'
import type { ReportTemplate, ReportSection } from './dashboard/useDashboard'
import type { CustomWidgetData } from './dashboard/CustomWidgetCard'

// ── CreateDashboardDialog ─────────────────────────────────────────────────────

interface CreateDashboardDialogProps {
  teams: Team[]
  onClose: () => void
  onCreated: (id: string) => void
}

function CreateDashboardDialog({ teams, onClose, onCreated }: CreateDashboardDialogProps) {
  const [name, setName]                   = useState('')
  const [visibility, setVisibility]       = useState('private')
  const [selectedTeams, setSelectedTeams] = useState<string[]>([])
  const [creating, setCreating]           = useState(false)

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
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 16 }}>Nuova dashboard</h2>

        <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>Nome</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Es. Operations Overview"
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 'var(--font-size-card-title)', marginBottom: 12, boxSizing: 'border-box' }}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
        />

        <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>Visibilità</label>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 'var(--font-size-card-title)', marginBottom: 12 }}
        >
          <option value="private">Privata (solo io)</option>
          <option value="teams">Condivisa con team</option>
          <option value="all">Tutti nel tenant</option>
        </select>

        {visibility === 'teams' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>Team</label>
            <div style={{ border: '1px solid #d1d5db', borderRadius: 6, maxHeight: 120, overflowY: 'auto' }}>
              {teams.map((t) => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}>
                  <input type="checkbox" checked={selectedTeams.includes(t.id)} onChange={() => toggleTeam(t.id)} style={{ margin: 0 }} />
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t.name}</span>
                </label>
              ))}
              {teams.length === 0 && <div style={{ padding: '8px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>Nessun team</div>}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', cursor: 'pointer' }}>
            Annulla
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim()}
            style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: creating || !name.trim() ? '#67e8f9' : 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-card-title)', fontWeight: 600, cursor: creating || !name.trim() ? 'not-allowed' : 'pointer' }}
          >
            {creating ? 'Creazione…' : 'Crea'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── SettingsDialog ────────────────────────────────────────────────────────────

interface SettingsDialogProps {
  dashboard: DashboardConfig
  teams: Team[]
  canDelete: boolean
  onClose: () => void
  onDeleted: () => void
  onUpdated: () => void
}

function SettingsDialog({ dashboard, teams, canDelete, onClose, onDeleted, onUpdated }: SettingsDialogProps) {
  const [name, setName]                   = useState(dashboard.name)
  const [visibility, setVisibility]       = useState(dashboard.visibility)
  const [selectedTeams, setSelectedTeams] = useState<string[]>(dashboard.sharedWith.map((t) => t.id))
  const [saving, setSaving]               = useState(false)
  const [deleting, setDeleting]           = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [updateDashboard] = useMutation(UPDATE_DASHBOARD)
  const [deleteDashboard] = useMutation(DELETE_DASHBOARD)

  async function handleSave() {
    setSaving(true)
    try {
      await updateDashboard({
        variables: {
          id: dashboard.id,
          input: { name: name.trim() || dashboard.name, visibility, sharedWithTeamIds: visibility === 'teams' ? selectedTeams : [] },
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
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 16 }}>Impostazioni dashboard</h2>

        <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>Nome</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 'var(--font-size-card-title)', marginBottom: 12, boxSizing: 'border-box' }}
        />

        <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>Visibilità</label>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 'var(--font-size-card-title)', marginBottom: 12 }}
        >
          <option value="private">Privata (solo io)</option>
          <option value="teams">Condivisa con team</option>
          <option value="all">Tutti nel tenant</option>
        </select>

        {visibility === 'teams' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>Team</label>
            <div style={{ border: '1px solid #d1d5db', borderRadius: 6, maxHeight: 120, overflowY: 'auto' }}>
              {teams.map((t) => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}>
                  <input type="checkbox" checked={selectedTeams.includes(t.id)} onChange={() => toggleTeam(t.id)} style={{ margin: 0 }} />
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {!dashboard.isDefault && (
          <button
            onClick={() => void handleSetDefault()}
            style={{ width: '100%', padding: '7px 14px', borderRadius: 6, border: '1px solid #0284c7', background: 'var(--color-brand-light)', color: 'var(--color-brand)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', marginBottom: 8 }}
          >
            ★ Imposta come default
          </button>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 8 }}>
          <div>
            {canDelete && !confirmDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fef2f2', color: 'var(--color-danger)', fontSize: 'var(--font-size-card-title)', cursor: 'pointer' }}
              >
                Elimina
              </button>
            )}
            {confirmDelete && (
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--color-danger)', color: '#fff', fontSize: 'var(--font-size-card-title)', fontWeight: 600, cursor: 'pointer' }}
              >
                {deleting ? 'Eliminazione…' : 'Conferma eliminazione'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', cursor: 'pointer' }}>
              Annulla
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: saving ? '#67e8f9' : 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-card-title)', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}
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
  // Local modal state — kept here (not in useDashboard) to avoid stale-closure issues
  const [showWidgetConfig, setShowWidgetConfig] = useState(false)
  const [editingWidget,    setEditingWidget]    = useState<CustomWidgetData | null>(null)

  const {
    activeDashboardId,
    editMode,
    pendingWidgets,
    expandedTemplates,
    saving,
    showCreate,
    showSettings,
    dropdownOpen,
    customWidgets,
    dashboards,
    activeDash,
    templates,
    teams,
    listLoading,
    dashLoading,
    dashData,
    activeDashName,
    setShowCreate,
    setShowSettings,
    setDropdownOpen,
    refetchList,
    refetchDash,
    enterEditMode,
    cancelEditMode,
    handleSave,
    handleDragEnd,
    handleRemoveWidget,
    handleUpdateColSpan,
    handleAddWidget,
    toggleTemplate,
    handleSelectDashboard,
    setActiveDashboardId,
    handleWidgetSaved,
    handleDeleteCustomWidget,
  } = useDashboard()

  function handleAddCustomWidget() {
    setEditingWidget(null)
    setShowWidgetConfig(true)
  }

  function handleEditCustomWidget(widget: CustomWidgetData) {
    setEditingWidget(widget)
    setShowWidgetConfig(true)
  }

  // ── Header ──────────────────────────────────────────────────────────────────

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <PageTitle icon={<LayoutDashboard size={22} color="var(--color-brand)" />}>
          Dashboard
        </PageTitle>

        {/* Dashboard selector dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}
          >
            <span>{activeDashName}</span>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>▼</span>
          </button>

          {dropdownOpen && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', minWidth: 220, zIndex: 100 }}>
              {dashboards.map((d) => (
                <button
                  key={d.id}
                  onClick={() => handleSelectDashboard(d.id)}
                  style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: d.id === activeDashboardId ? '#f0f9ff' : 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: d.id === activeDashboardId ? 'var(--color-brand-hover)' : 'var(--color-slate)', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  {d.isDefault && <span style={{ fontSize: 'var(--font-size-label)', color: '#f59e0b' }}>★</span>}
                  <span>{d.name}</span>
                  {d.visibility !== 'private' && (
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                      {d.visibility === 'all' ? 'tutti' : 'team'}
                    </span>
                  )}
                </button>
              ))}
              <div style={{ borderTop: '1px solid #f3f4f6', padding: 4 }}>
                <button
                  onClick={() => { setDropdownOpen(false); setShowCreate(true) }}
                  style={{ width: '100%', padding: '7px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500 }}
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
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #0284c7', background: saving ? '#67e8f9' : 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer' }}
            >
              {saving ? 'Salvataggio…' : '✓ Salva'}
            </button>
            <button
              onClick={cancelEditMode}
              disabled={saving}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}
            >
              ✕ Annulla
            </button>
          </>
        ) : (
          <>
            <button onClick={enterEditMode} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}>
              ✏ Personalizza
            </button>
            <button onClick={() => setShowSettings(true)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}>
              ⚙ Impostazioni
            </button>
          </>
        )}
      </div>
    </div>
  )

  // ── Loading ──────────────────────────────────────────────────────────────────

  if (listLoading || (activeDashboardId && dashLoading && !dashData)) {
    return <div style={{ padding: 32, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>Caricamento…</div>
  }

  // ── VIEW MODE ────────────────────────────────────────────────────────────────

  if (!editMode) {
    const viewWidgets      = activeDash?.widgets ?? []
    const viewCustomWidgets = customWidgets
    const isEmpty = viewWidgets.length === 0 && viewCustomWidgets.length === 0
    return (
      <PageContainer>
        {header}
        {isEmpty ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
            La dashboard è vuota. Clicca <strong>Personalizza</strong> per aggiungere i tuoi report.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16, padding: 24 }}>
            {viewWidgets.map((widget) => (
              <DashboardWidget key={widget.id} widget={widget} />
            ))}
            {viewCustomWidgets.map((widget) => (
              <CustomWidgetCard key={widget.id} widget={widget} editMode={false} />
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
        {showWidgetConfig && activeDashboardId && (
          <WidgetConfigPanel
            dashboardId={activeDashboardId}
            widget={editingWidget}
            onClose={() => setShowWidgetConfig(false)}
            onSaved={handleWidgetSaved}
          />
        )}
      </PageContainer>
    )
  }

  // ── EDIT MODE ────────────────────────────────────────────────────────────────
  // Do NOT wrap in PageContainer — it adds 2.5rem padding that combined with
  // DashboardEditMode's own padding causes overflow clipping in AppLayout.

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header strip */}
      <div style={{ flexShrink: 0, background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
        {header}
      </div>

      {/* Edit area — fills remaining height, scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <DashboardEditMode
          pendingWidgets={pendingWidgets}
          templates={templates}
          expandedTemplates={expandedTemplates}
          customWidgets={customWidgets}
          onDragEnd={handleDragEnd}
          onRemoveWidget={handleRemoveWidget}
          onUpdateColSpan={handleUpdateColSpan}
          onAddWidget={(template, section) => handleAddWidget(template as ReportTemplate, section as ReportSection)}
          onToggleTemplate={toggleTemplate}
          onAddCustomWidget={handleAddCustomWidget}
          onEditCustomWidget={handleEditCustomWidget}
          onDeleteCustomWidget={(id) => void handleDeleteCustomWidget(id)}
        />
      </div>

      {showWidgetConfig && activeDashboardId && (
        <WidgetConfigPanel
          dashboardId={activeDashboardId}
          widget={editingWidget}
          onClose={() => setShowWidgetConfig(false)}
          onSaved={handleWidgetSaved}
        />
      )}
    </div>
  )
}

export default DashboardPage
