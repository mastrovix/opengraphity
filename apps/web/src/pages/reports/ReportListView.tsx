import { useTranslation } from 'react-i18next'
import { Hash, PieChart, CircleDot, BarChart2, BarChart, LineChart, TrendingUp, Table as TableIcon, LayoutGrid } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import {
  type ReportTemplate,
  VIS_LABELS, VIS_COLORS,
  inputStyle, labelStyle, btnPrimary, btnGhost,
} from './useCustomReports'

// ── Chart icon helper ────────────────────────────────────────────────────────

const CHART_ICON_MAP: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  kpi: Hash, pie: PieChart, donut: CircleDot,
  bar: BarChart2, bar_horizontal: BarChart,
  line: LineChart, area: TrendingUp, table: TableIcon,
}

function getReportIcon(template: ReportTemplate) {
  const chartType = template.sections?.[0]?.chartType ?? 'bar'
  const Icon = CHART_ICON_MAP[chartType] ?? BarChart2
  return <Icon size={20} color="var(--color-brand)" />
}

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
            <PageTitle icon={<LayoutGrid size={22} color="var(--color-brand)" />}>
              {tr('pages.reportBuilder.title')}
            </PageTitle>
            <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
              {tr('pages.reportBuilder.count', { count: templates.length })}
            </p>
          </div>
          <button
            onClick={() => setShowNewDialog(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
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
            const vc = VIS_COLORS[t.visibility] ?? VIS_COLORS.private
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
                            <button key={item.label} onClick={item.action} style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              padding: '10px 14px', border: 'none', background: 'none',
                              cursor: 'pointer', fontSize: 'var(--font-size-card-title)',
                              color: item.danger ? 'var(--color-trigger-sla-breach)' : 'var(--color-slate)',
                            }}
                              onMouseEnter={e => (e.currentTarget.style.background = item.danger ? '#fef2f2' : '#f9fafb')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                            >{item.label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Subtitle row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: vc.bg, color: vc.fg }}>
                      {VIS_LABELS[t.visibility] ?? t.visibility}
                    </span>
                    {t.createdBy && (
                      <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>· {t.createdBy.name}</span>
                    )}
                  </div>
                </div>

                {/* Card footer */}
                <div style={{ padding: '8px 14px', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => handleExecuteAndGoToDetail(t)}
                    style={{ ...btnGhost, flex: 1, fontSize: 'var(--font-size-body)', padding: '4px 10px' }}
                  >&#x25B6; {tr('pages.reportBuilder.execute')}</button>
                  <button
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ fontWeight: 600, fontSize: 'var(--font-size-section-title)', marginBottom: 20, color: 'var(--color-slate-dark)' }}>Nuovo report</div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Nome *</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} style={inputStyle} placeholder="Nome report..." />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Descrizione</label>
              <textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Visibilit&agrave;</label>
              <select value={newVis} onChange={e => setNewVis(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
                <option value="private">Privato</option>
                <option value="groups">Gruppi selezionati</option>
                <option value="all">Tutti</option>
              </select>
            </div>
            {newVis === 'groups' && teams.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Team</label>
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

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowNewDialog(false); resetNew() }} style={btnGhost}>Annulla</button>
              <button disabled={!newName || creating} onClick={() => void handleCreateTemplate()}
                style={{ ...btnPrimary, opacity: !newName || creating ? 0.6 : 1 }}>
                {creating ? 'Creazione...' : 'Crea report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
