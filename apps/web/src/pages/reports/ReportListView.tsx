import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { QueryError, StaleDataBanner } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { lookupOrError, colors } from '@/lib/tokens'
import {
  type ReportTemplate,
  VIS_LABEL_KEYS, VIS_COLORS,
  inputStyle, labelStyle, btnPrimary, btnGhost,
} from './useCustomReports'

import { getReportIcon } from './reportIcons'

// ── Props ────────────────────────────────────────────────────────────────────

interface ReportListViewProps {
  templates: ReportTemplate[]
  /** The list is being read / could not be read: not the same as «no reports». */
  templatesLoading?: boolean
  templatesError?: { message: string } | null
  onRetryTemplates?: () => void
  teams: { id: string; name: string }[]
  teamsError?: { message: string } | null
  menuRef: React.RefObject<HTMLDivElement | null>
  menuOpenId: string | null
  setMenuOpenId: (id: string | null) => void
  // New dialog
  showNewDialog: boolean
  setShowNewDialog: (v: boolean) => void
  newName: string; setNewName: (v: string) => void
  newDesc: string; setNewDesc: (v: string) => void
  newVis: string; setNewVis: (v: string) => void
  newTeamIds: string[]; setNewTeamIds: (v: string[] | ((prev: string[]) => string[])) => void
  creating: boolean
  /** report.write: without it the report is read and run, never created, changed or deleted. */
  canWrite: boolean
  // Handlers
  goToDetail: (tpl: ReportTemplate) => void
  handleExecuteAndGoToDetail: (tpl: ReportTemplate) => void
  openSettings: (tpl: ReportTemplate) => void
  duplicateTemplate: (tpl: ReportTemplate) => void
  handleDeleteTemplate: (id: string) => void
  handleCreateTemplate: () => void
  resetNew: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReportListView(props: ReportListViewProps) {
  // `t` NON si rinomina: `scripts/check-i18n.mjs` cerca `t('…')`, e con
  // l'alias `tr` le sue chiavi erano invisibili al controllo. Cinque chiavi
  // `pages.reportBuilder.*` mancavano da entrambe le lingue e la pagina
  // mostrava i nomi delle chiavi — trovato girando nel browser, non dai test.
  const { t } = useTranslation()
  const uid = useId()
  const ids = { name: `${uid}-name`, desc: `${uid}-desc`, vis: `${uid}-vis` }
  const {
    templates, templatesLoading = false, templatesError = null, onRetryTemplates, teams, teamsError = null, menuRef, menuOpenId, setMenuOpenId,
    showNewDialog, setShowNewDialog,
    newName, setNewName, newDesc, setNewDesc, newVis, setNewVis, newTeamIds, setNewTeamIds,
    creating, canWrite,
    goToDetail, handleExecuteAndGoToDetail, openSettings, duplicateTemplate, handleDeleteTemplate, handleCreateTemplate, resetNew,
  } = props
  const listKnown = !templatesLoading && !templatesError

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <PageTitle icon={<LayoutGrid size={22} color="var(--color-icon-accent)" />}>
              {t('pages.reportBuilder.title')}
            </PageTitle>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
              {listKnown ? t('pages.reportBuilder.count', { count: templates.length }) : '—'}
            </p>
          </div>
          {canWrite && <button
            type="button"
            onClick={() => setShowNewDialog(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: 'var(--color-brand)', color: colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          >
            {t('pages.reportBuilder.new')}
          </button>}
        </div>

        {/* Not read yet, or not readable: said as such, never as «no reports» (review of 23 Sep 2026). */}
        {templatesError && templates.length === 0 && (
          <QueryError message={templatesError.message} onRetry={onRetryTemplates} />
        )}
        {templatesError && templates.length > 0 && (
          <StaleDataBanner message={templatesError.message} onRetry={onRetryTemplates} />
        )}
        {!templatesError && templatesLoading && templates.length === 0 && (
          <p role="status" style={{ color: 'var(--color-slate-light)' }}>{t('common.loading')}</p>
        )}

        {/* Empty state */}
        {listKnown && templates.length === 0 && (
          <EmptyState
            icon={<LayoutGrid size={32} color="var(--color-slate-light)" />}
            title={t('pages.reports.emptyTitle')}
            description={t('pages.reports.emptyDescription')}
          />
        )}

        {/* Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }} ref={menuRef}>
          {templates.map((tpl: ReportTemplate) => {
            const vc = lookupOrError(VIS_COLORS, tpl.visibility, 'VIS_COLORS', VIS_COLORS.private)
            const isMenuOpen = menuOpenId === tpl.id
            return (
              <div key={tpl.id} style={{
                background: colors.white, borderRadius: 10, border: '1px solid var(--color-border)',
                boxShadow: '0 1px 2px var(--color-black-a05)',
                display: 'flex', flexDirection: 'column',
              }}>
                {/* Card header row */}
                <div style={{ padding: '14px 14px 10px', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{getReportIcon(tpl)}</span>
                    <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.name}</span>
                    {/* Menu: every entry writes, so without report.write there is none (review of 23 Sep 2026). */}
                    {canWrite && <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={isMenuOpen}
                        onClick={e => { e.stopPropagation(); setMenuOpenId(isMenuOpen ? null : tpl.id) }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 5px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', lineHeight: 1, borderRadius: 4 }}
                      >&#x22EE;</button>
                      {isMenuOpen && (
                        <div style={{
                          position: 'absolute', top: '100%', right: 0, zIndex: 50,
                          background: colors.white, border: '1px solid var(--color-border)', borderRadius: 8,
                          boxShadow: '0 4px 16px var(--color-black-a12)', minWidth: 180, overflow: 'hidden',
                        }}>
                          {[
                            { label: `\u2699 ${t('pages.reports.editSettings')}`, action: () => openSettings(tpl), danger: false },
                            { label: `\u29C9 ${t('pages.reports.duplicate')}`,     action: () => duplicateTemplate(tpl), danger: false },
                            { label: `\uD83D\uDDD1 ${t('common.delete')}`,        action: () => handleDeleteTemplate(tpl.id), danger: true },
                          ].map(item => (
                            <button key={item.label} type="button" onClick={item.action} className="hover-bg" style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              padding: '10px 14px', border: 'none',
                              cursor: 'pointer', fontSize: 'var(--font-size-card-title)',
                              color: item.danger ? 'var(--color-trigger-sla-breach)' : 'var(--color-slate)',
                              ['--hover-bg' as string]: item.danger ? 'var(--color-danger-bg)' : 'var(--color-slate-bg)',
                            }}
                            >{item.label}</button>
                          ))}
                        </div>
                      )}
                    </div>}
                  </div>

                  {/* Subtitle row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: vc.bg, color: vc.fg }}>
                      {t(lookupOrError(VIS_LABEL_KEYS, tpl.visibility, 'VIS_LABEL_KEYS', tpl.visibility))}
                    </span>
                    {tpl.createdBy && (
                      <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>· {tpl.createdBy.name}</span>
                    )}
                  </div>
                </div>

                {/* Card footer */}
                <div style={{ padding: '8px 14px', borderTop: '1px solid var(--color-border-light)', display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => handleExecuteAndGoToDetail(tpl)}
                    style={{ ...btnGhost, flex: 1, fontSize: 'var(--font-size-body)', padding: '4px 10px' }}
                  >&#x25B6; {t('pages.reportBuilder.execute')}</button>
                  <button
                    type="button"
                    onClick={() => goToDetail(tpl)}
                    style={{ ...btnPrimary, flex: 1, fontSize: 'var(--font-size-body)', padding: '4px 10px' }}
                  >{canWrite ? <>&#x270F; {t('pages.reportBuilder.modify')}</> : t('pages.reportBuilder.open')}</button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── New template dialog ────────────────────────────────────────────────── */}
      {showNewDialog && (
        <Modal
          open
          onClose={() => { setShowNewDialog(false); resetNew() }}
          title={t('pages.reports.newReport')}
          width={440}
          footer={
            <>
              <Button variant="secondary" onClick={() => { setShowNewDialog(false); resetNew() }} style={btnGhost}>{t('common.cancel')}</Button>
              <Button disabled={!newName || creating} onClick={() => handleCreateTemplate()}
                style={{ ...btnPrimary, opacity: !newName || creating ? 0.6 : 1 }}>
                {creating ? t('pages.reports.creating') : t('pages.reports.create')}
              </Button>
            </>
          }
        >
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={ids.name} style={labelStyle}>{t('pages.slaReport.nameRequired')}</label>
              <input id={ids.name} value={newName} onChange={e => setNewName(e.target.value)} style={inputStyle} placeholder={t('pages.reports.namePlaceholder')} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={ids.desc} style={labelStyle}>{t('common.description')}</label>
              <textarea id={ids.desc} value={newDesc} onChange={e => setNewDesc(e.target.value)} style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label htmlFor={ids.vis} style={labelStyle}>{t('pages.reports.visibility.label')}</label>
              <select id={ids.vis} value={newVis} onChange={e => setNewVis(e.target.value)} style={{ ...inputStyle, background: colors.white }}>
                <option value="private">{t('pages.reports.visibility.private')}</option>
                <option value="groups">{t('pages.reports.visibility.selectedGroups')}</option>
                <option value="all">{t('common.all')}</option>
              </select>
            </div>
            {newVis === 'groups' && teamsError && (
              <p role="alert" style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-body)' }}>{t('pages.reportSchedule.teamsError', { message: teamsError.message })}</p>
            )}
            {newVis === 'groups' && teams.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={labelStyle}>{t('sidebar.teams')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {teams.map((team: { id: string; name: string }) => (
                    <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-card-title)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={newTeamIds.includes(team.id)}
                        onChange={e => setNewTeamIds(prev => e.target.checked ? [...prev, team.id] : prev.filter((x: string) => x !== team.id))} />
                      {team.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

        </Modal>
      )}
    </>
  )
}
