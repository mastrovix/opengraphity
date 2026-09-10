import { useState, useId, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { Input, Select } from '@/components/ui/FormControls'
import { toast } from 'sonner'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { LayoutDashboard } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import {
  CREATE_DASHBOARD,
  UPDATE_DASHBOARD,
  DELETE_DASHBOARD,
} from '@/graphql/mutations'
const DashboardWidget = lazy(() => import('./dashboard/DashboardWidget').then(m => ({ default: m.DashboardWidget })))
const DashboardEditMode = lazy(() => import('./dashboard/DashboardEditMode').then(m => ({ default: m.DashboardEditMode })))
const CustomWidgetCard = lazy(() => import('./dashboard/CustomWidgetCard').then(m => ({ default: m.CustomWidgetCard })))
const WidgetConfigPanel = lazy(() => import('./dashboard/WidgetConfigPanel').then(m => ({ default: m.WidgetConfigPanel })))
import { useDashboard } from './dashboard/useDashboard'
import type { DashboardConfig, Team } from './dashboard/useDashboard'
import type { ReportTemplate, ReportSection } from './dashboard/useDashboard'
import type { CustomWidgetData } from './dashboard/CustomWidgetCard'
import { colors, palette } from '@/lib/tokens'

// ── Shared styles ─────────────────────────────────────────────────────────────

const fieldLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4,
}

// ── TeamPicker (checkbox list shared by both dialogs) ─────────────────────────

function TeamPicker({ teams, selected, onToggle }: { teams: Team[]; selected: string[]; onToggle: (id: string) => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ marginBottom: 12 }}>
      {/* Titolo del gruppo di checkbox: non etichetta un singolo controllo */}
      <div style={fieldLabelStyle}>{t('detail.team')}</div>
      <div style={{ border: '1px solid var(--color-border-strong)', borderRadius: 6, maxHeight: 120, overflowY: 'auto' }}>
        {teams.map((team) => (
          <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid var(--color-border-light)' }}>
            <input type="checkbox" checked={selected.includes(team.id)} onChange={() => onToggle(team.id)} style={{ margin: 0 }} />
            <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{team.name}</span>
          </label>
        ))}
        {teams.length === 0 && <div style={{ padding: '8px 10px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('pages.dashboard.noTeams')}</div>}
      </div>
    </div>
  )
}

// ── CreateDashboardDialog ─────────────────────────────────────────────────────

interface CreateDashboardDialogProps {
  teams: Team[]
  onClose: () => void
  onCreated: (id: string) => void
}

function CreateDashboardDialog({ teams, onClose, onCreated }: CreateDashboardDialogProps) {
  const { t } = useTranslation()
  const id = useId()
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
      toast.success(t('toast.dashboard.created'))
      onCreated(created.id)
    } catch (err: unknown) {
      toast.error(t('toast.dashboard.createFailed', { error: errorMessage(err) }))
    } finally {
      setCreating(false)
    }
  }

  function toggleTeam(teamId: string) {
    setSelectedTeams((prev) =>
      prev.includes(teamId) ? prev.filter((x) => x !== teamId) : [...prev, teamId],
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('pages.dashboard.newDashboard')}
      width={380}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} style={{ padding: '7px 14px', border: '1px solid var(--color-border-strong)', fontSize: 'var(--font-size-card-title)' }}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim()}
            style={{ padding: '7px 14px', backgroundColor: creating || !name.trim() ? palette.teal.border : 'var(--color-brand)', fontSize: 'var(--font-size-card-title)', fontWeight: 600 }}
          >
            {creating ? t('pages.dashboard.creating') : t('common.create')}
          </Button>
        </>
      }
    >
        <label htmlFor={id + '-name'} style={fieldLabelStyle}>{t('pages.dashboard.name')}</label>
        <Input
          id={id + '-name'}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo aperto dall'utente (campo principale)
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('pages.dashboard.namePlaceholder')}
          style={{ padding: '8px 10px', fontSize: 'var(--font-size-card-title)', marginBottom: 12, outline: undefined }}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
        />

        <label htmlFor={id + '-visibility'} style={fieldLabelStyle}>{t('pages.dashboard.visibility')}</label>
        <Select
          id={id + '-visibility'}
          value={visibility}
          onChange={(e) => setVisibility(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 'var(--font-size-card-title)', marginBottom: 12, outline: undefined }}
        >
          <option value="private">{t('pages.dashboard.visibilityPrivate')}</option>
          <option value="teams">{t('pages.dashboard.visibilityTeams')}</option>
          <option value="all">{t('pages.dashboard.visibilityAll')}</option>
        </Select>

        {visibility === 'teams' && (
          <TeamPicker teams={teams} selected={selectedTeams} onToggle={toggleTeam} />
        )}

    </Modal>
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
  const { t } = useTranslation()
  const id = useId()
  const [name, setName]                   = useState(dashboard.name)
  const [visibility, setVisibility]       = useState(dashboard.visibility)
  const [selectedTeams, setSelectedTeams] = useState<string[]>(dashboard.sharedWith.map((team) => team.id))
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
      toast.success(t('toast.dashboard.updated'))
      onUpdated()
      onClose()
    } catch (err: unknown) {
      toast.error(t('toast.dashboard.updateFailed', { error: errorMessage(err) }))
    } finally {
      setSaving(false)
    }
  }

  async function handleSetDefault() {
    try {
      await updateDashboard({ variables: { id: dashboard.id, input: { isDefault: true } } })
      toast.success(t('toast.dashboard.setDefault'))
      onUpdated()
    } catch (err: unknown) {
      toast.error(t('toast.dashboard.updateFailed', { error: errorMessage(err) }))
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteDashboard({ variables: { id: dashboard.id } })
      toast.success(t('toast.dashboard.deleted'))
      onDeleted()
      onClose()
    } catch (err: unknown) {
      toast.error(t('toast.dashboard.deleteFailed', { error: errorMessage(err) }))
    } finally {
      setDeleting(false)
    }
  }

  function toggleTeam(teamId: string) {
    setSelectedTeams((prev) =>
      prev.includes(teamId) ? prev.filter((x) => x !== teamId) : [...prev, teamId],
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('pages.dashboard.settingsTitle')}
      width={400}
      footerStyle={{ justifyContent: 'space-between' }}
      footer={
        <>
          <div>
            {canDelete && !confirmDelete && (
              <Button
                variant="secondary"
                onClick={() => setConfirmDelete(true)}
                style={{ padding: '7px 14px', border: '1px solid var(--color-danger-border-strong)', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', fontSize: 'var(--font-size-card-title)' }}
              >
                {t('common.delete')}
              </Button>
            )}
            {confirmDelete && (
              <Button
                onClick={() => void handleDelete()}
                disabled={deleting}
                style={{ padding: '7px 14px', backgroundColor: 'var(--color-danger)', fontSize: 'var(--font-size-card-title)', fontWeight: 600 }}
              >
                {deleting ? t('pages.dashboard.deleting') : t('pages.dashboard.confirmDelete')}
              </Button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onClose} style={{ padding: '7px 14px', border: '1px solid var(--color-border-strong)', fontSize: 'var(--font-size-card-title)' }}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ padding: '7px 14px', backgroundColor: saving ? palette.teal.border : 'var(--color-brand)', fontSize: 'var(--font-size-card-title)', fontWeight: 600 }}
            >
              {saving ? t('pages.dashboard.saving') : t('common.save')}
            </Button>
          </div>
        </>
      }
    >
        <label htmlFor={id + '-name'} style={fieldLabelStyle}>{t('pages.dashboard.name')}</label>
        <Input
          id={id + '-name'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 'var(--font-size-card-title)', marginBottom: 12, outline: undefined }}
        />

        <label htmlFor={id + '-visibility'} style={fieldLabelStyle}>{t('pages.dashboard.visibility')}</label>
        <Select
          id={id + '-visibility'}
          value={visibility}
          onChange={(e) => setVisibility(e.target.value)}
          style={{ padding: '8px 10px', fontSize: 'var(--font-size-card-title)', marginBottom: 12, outline: undefined }}
        >
          <option value="private">{t('pages.dashboard.visibilityPrivate')}</option>
          <option value="teams">{t('pages.dashboard.visibilityTeams')}</option>
          <option value="all">{t('pages.dashboard.visibilityAll')}</option>
        </Select>

        {visibility === 'teams' && (
          <TeamPicker teams={teams} selected={selectedTeams} onToggle={toggleTeam} />
        )}

        {!dashboard.isDefault && (
          <button
            type="button"
            onClick={() => void handleSetDefault()}
            style={{ width: '100%', padding: '7px 14px', borderRadius: 6, border: '1px solid var(--color-brand)', background: 'var(--color-brand-light)', color: 'var(--color-brand)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', marginBottom: 8 }}
          >
            ★ {t('pages.dashboard.setDefault')}
          </button>
        )}
    </Modal>
  )
}

// ── DashboardPage ─────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation()
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
        <PageTitle icon={<LayoutDashboard size={22} color="var(--color-icon-accent)" />}>
          {t('pages.dashboard.title')}
        </PageTitle>

        {/* Dashboard selector dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={dropdownOpen}
            aria-label={t('pages.dashboard.selectDashboard')}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: colors.white, color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}
          >
            <span>{activeDashName}</span>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>▼</span>
          </button>

          {dropdownOpen && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: colors.white, border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: '0 4px 16px var(--color-black-a10)', minWidth: 220, zIndex: 100 }}>
              {dashboards.map((d) => (
                <button
                  type="button"
                  key={d.id}
                  onClick={() => handleSelectDashboard(d.id)}
                  style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: d.id === activeDashboardId ? palette.info.light : 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: d.id === activeDashboardId ? 'var(--color-brand-hover)' : 'var(--color-slate)', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  {d.isDefault && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-warning)' }}>★</span>}
                  <span>{d.name}</span>
                  {d.visibility !== 'private' && (
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                      {d.visibility === 'all' ? t('pages.dashboard.badgeAll') : t('pages.dashboard.badgeTeam')}
                    </span>
                  )}
                </button>
              ))}
              <div style={{ borderTop: '1px solid var(--color-border-light)', padding: 4 }}>
                <button
                  type="button"
                  onClick={() => { setDropdownOpen(false); setShowCreate(true) }}
                  style={{ width: '100%', padding: '7px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500 }}
                >
                  + {t('pages.dashboard.newDashboard')}
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
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--color-brand)', background: saving ? palette.teal.border : 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer' }}
            >
              {saving ? t('pages.dashboard.saving') : `✓ ${t('common.save')}`}
            </button>
            <button
              type="button"
              onClick={cancelEditMode}
              disabled={saving}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: colors.white, color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}
            >
              ✕ {t('common.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={enterEditMode} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: colors.white, color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}>
              ✏ {t('pages.dashboard.customize')}
            </button>
            <button type="button" onClick={() => setShowSettings(true)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: colors.white, color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer' }}>
              ⚙ {t('pages.dashboard.settings')}
            </button>
          </>
        )}
      </div>
    </div>
  )

  // ── Loading ──────────────────────────────────────────────────────────────────

  if (listLoading || (activeDashboardId && dashLoading && !dashData)) {
    return <div style={{ padding: 32, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
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
            {t('pages.dashboard.emptyHintBefore')} <strong>{t('pages.dashboard.customize')}</strong> {t('pages.dashboard.emptyHintAfter')}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 16, padding: 24 }}>
            {viewWidgets.map((widget) => (
              <Suspense key={widget.id} fallback={<div style={{ minHeight: 120 }} />}><DashboardWidget widget={widget} /></Suspense>
            ))}
            {viewCustomWidgets.map((widget) => (
              <Suspense key={widget.id} fallback={<div style={{ minHeight: 120 }} />}><CustomWidgetCard widget={widget} editMode={false} /></Suspense>
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
          <Suspense fallback={null}>
            <WidgetConfigPanel
              dashboardId={activeDashboardId}
              widget={editingWidget}
              onClose={() => setShowWidgetConfig(false)}
              onSaved={handleWidgetSaved}
            />
          </Suspense>
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
      <div style={{ flexShrink: 0, background: 'var(--color-slate-bg)', borderBottom: '1px solid var(--color-border)' }}>
        {header}
      </div>

      {/* Edit area — fills remaining height, scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <Suspense fallback={null}>
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
        </Suspense>
      </div>

      {showWidgetConfig && activeDashboardId && (
        <Suspense fallback={null}>
          <WidgetConfigPanel
            dashboardId={activeDashboardId}
            widget={editingWidget}
            onClose={() => setShowWidgetConfig(false)}
            onSaved={handleWidgetSaved}
          />
        </Suspense>
      )}
    </div>
  )
}

export default DashboardPage
