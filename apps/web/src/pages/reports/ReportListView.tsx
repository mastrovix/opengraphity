import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { lookupOrError } from '@/lib/tokens'
import {
  type ReportTemplate,
  VIS_LABELS, VIS_COLORS,
  inputStyle, labelStyle, btnPrimary, btnGhost,
} from './useCustomReports'

import { getReportIcon } from './reportIcons'

// ── Props ────────────────────────────────────────────────────────────────────

interface ReportListViewProps {
  templates: ReportTemplate[]
  teams: { id: string; name: string }[]
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
  // Handlers
  goToDetail: (t: ReportTemplate) => void
  handleExecuteAndGoToDetail: (t: ReportTemplate) => void
  openSettings: (t: ReportTemplate) => void
  duplicateTemplate: (t: ReportTemplate) => void
  handleDeleteTemplate: (id: string) => void
  handleCreateTemplate: () => void
  resetNew: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReportListView(props: ReportListViewProps) {
  const { t: tr } = useTranslation()
  const uid = useId()
  const ids = { name: `${uid}-name`, desc: `${uid}-desc`, vis: `${uid}-vis` }
  const {
    templates, teams, menuRef, menuOpenId, setMenuOpenId,
    showNewDialog, setShowNewDialog,
    newName, setNewName, newDesc, setNewDesc, newVis, setNewVis, newTeamIds, setNewTeamIds,
    creating,
    goToDetail, handleExecuteAndGoToDetail, openSettings, duplicateTemplate, handleDeleteTemplate, handleCreateTemplate, resetNew,
  } = props

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <PageTitle icon={<LayoutGrid size={22} color="var(--color-icon-accent)" />}>
              {tr('pages.reportBuilder.title')}
            </PageTitle>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
              {tr('pages.reportBuilder.count', { count: templates.length })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNewDialog(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: 'var(--color-brand)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
          >
            {tr('pages.reportBuilder.new')}
          </button>
        </div>

        {/* Empty state */}
        {templates.length === 0 && (
          <EmptyState
            icon={<LayoutGrid size={32} color="var(--color-slate-light)" />}
            title="Nessun report ancora"
            description="Crea il tuo primo report personalizzato"
          />
        )}

        {/* Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }} ref={menuRef}>
          {templates.map((t: ReportTemplate) => {
            const vc = lookupOrError(VIS_COLORS, t.visibility, 'VIS_COLORS', VIS_COLORS.private)
            const isMenuOpen = menuOpenId === t.id
            return (
              <div key={t.id} style={{
                background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb',
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                display: 'flex', flexDirection: 'column',
              }}>
                {/* Card header row */}
                <div style={{ padding: '14px 14px 10px', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{getReportIcon(t)}</span>
                    <span style={{ fontWeight: 600, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                    {/* Menu */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={isMenuOpen}
                        onClick={e => { e.stopPropagation(); setMenuOpenId(isMenuOpen ? null : t.id) }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 5px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', lineHeight: 1, borderRadius: 4 }}
                      >&#x22EE;</button>
                      {isMenuOpen && (
                        <div style={{
                          position: 'absolute', top: '100%', right: 0, zIndex: 50,
                          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
                          boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 180, overflow: 'hidden',
                        }}>
                          {[
                            { label: '\u2699 Modifica impostazioni', action: () => openSettings(t), danger: false },
                            { label: '\u29C9 Duplica',               action: () => duplicateTemplate(t), danger: false },
                            { label: '\uD83D\uDDD1 Elimina',        action: () => handleDeleteTemplate(t.id), danger: true },
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
                    </div>
                  </div>

                  {/* Subtitle row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: vc.bg, color: vc.fg }}>
                      {lookupOrError(VIS_LABELS, t.visibility, 'VIS_LABELS', t.visibility)}
                    </span>
                    {t.createdBy && (
                      <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>· {t.createdBy.name}</span>
                    )}
                  </div>
                </div>

                {/* Card footer */}
                <div style={{ padding: '8px 14px', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => handleExecuteAndGoToDetail(t)}
                    style={{ ...btnGhost, flex: 1, fontSize: 'var(--font-size-body)', padding: '4px 10px' }}
                  >&#x25B6; {tr('pages.reportBuilder.execute')}</button>
                  <button
                    type="button"
                    onClick={() => goToDetail(t)}
                    style={{ ...btnPrimary, flex: 1, fontSize: 'var(--font-size-body)', padding: '4px 10px' }}
                  >&#x270F; {tr('pages.reportBuilder.modify')}</button>
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
          title="Nuovo report"
          width={440}
          footer={
            <>
              <Button variant="secondary" onClick={() => { setShowNewDialog(false); resetNew() }} style={btnGhost}>Annulla</Button>
              <Button disabled={!newName || creating} onClick={() => void handleCreateTemplate()}
                style={{ ...btnPrimary, opacity: !newName || creating ? 0.6 : 1 }}>
                {creating ? 'Creazione...' : 'Crea report'}
              </Button>
            </>
          }
        >
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={ids.name} style={labelStyle}>Nome *</label>
              <input id={ids.name} value={newName} onChange={e => setNewName(e.target.value)} style={inputStyle} placeholder="Nome report..." />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={ids.desc} style={labelStyle}>Descrizione</label>
              <textarea id={ids.desc} value={newDesc} onChange={e => setNewDesc(e.target.value)} style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label htmlFor={ids.vis} style={labelStyle}>Visibilit&agrave;</label>
              <select id={ids.vis} value={newVis} onChange={e => setNewVis(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
                <option value="private">Privato</option>
                <option value="groups">Gruppi selezionati</option>
                <option value="all">Tutti</option>
              </select>
            </div>
            {newVis === 'groups' && teams.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={labelStyle}>Team</div>
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
