import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useLazyQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import {
  GET_REPORT_TEMPLATES,
  EXECUTE_REPORT,
} from '@/graphql/queries'
import {
  CREATE_REPORT_TEMPLATE,
  UPDATE_REPORT_TEMPLATE,
  DELETE_REPORT_TEMPLATE,
  ADD_REPORT_SECTION,
  UPDATE_REPORT_SECTION,
  REMOVE_REPORT_SECTION,
  EXPORT_REPORT_PDF,
  EXPORT_REPORT_EXCEL,
  UPDATE_REPORT_SCHEDULE,
} from '@/graphql/mutations'
import { Hash, PieChart, CircleDot, BarChart2, BarChart, LineChart, TrendingUp, Table as TableIcon, LayoutGrid } from 'lucide-react'
import { toast } from 'sonner'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { ReportChartRenderer } from '@/components/ReportChartRenderer'
import { ReportSectionBuilder, type ReportSectionInput } from '@/components/ReportSectionBuilder'

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReportNode { id: string; entityType: string; neo4jLabel: string; label: string; isResult: boolean; isRoot: boolean; positionX: number; positionY: number; filters: string | null; selectedFields: string[] }
interface ReportEdge { id: string; sourceNodeId: string; targetNodeId: string; relationshipType: string; direction: string; label: string }
interface ReportSection { id: string; order: number; title: string; chartType: string; groupByNodeId: string | null; groupByField: string | null; metric: string; metricField: string | null; limit: number | null; sortDir: string | null; nodes: ReportNode[]; edges: ReportEdge[] }
interface ReportTemplate { id: string; name: string; description: string | null; icon: string | null; visibility: string; scheduleEnabled: boolean; scheduleCron: string | null; scheduleChannelId?: string | null; scheduleRecipients: string[]; scheduleFormat: string | null; lastScheduledRun: string | null; createdAt: string; updatedAt?: string; createdBy: { id: string; name: string } | null; sharedWith: { id: string; name: string }[]; sections: ReportSection[] }
interface Channel { id: string; name: string; platform: string }
interface SectionResult { sectionId: string; title: string; chartType: string; data: string; total: number | null; error: string | null }

const GET_CHANNELS_SLIM = gql`query GetChannelsSlim { notificationChannels { id name platform } }`
const GET_TEAMS_SLIM    = gql`query GetTeamsSlim { teams { id name } }`

type View = 'list' | 'detail' | 'add-section' | 'edit-section' | 'settings'

const SCHEDULE_PRESETS = [
  { label: 'Ogni giorno alle 9:00',      value: '0 9 * * *' },
  { label: 'Ogni lunedì alle 9:00',      value: '0 9 * * 1' },
  { label: 'Ogni primo del mese alle 9', value: '0 9 1 * *' },
  { label: 'Personalizzata',             value: '__custom__' },
]

const VIS_LABELS: Record<string, string> = { private: 'Privato', groups: 'Gruppi', all: 'Tutti' }
const VIS_COLORS: Record<string, { bg: string; fg: string }> = {
  all:     { bg: '#dcfce7', fg: '#15803d' },
  groups:  { bg: '#fef3c7', fg: '#92400e' },
  private: { bg: '#f3f4f6', fg: 'var(--color-slate)' },
}

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

// ── Page ───────────────────────────────────────────────────────────────────────

export function CustomReportsPage() {
  const { t: tr } = useTranslation()
  const [view,           setView]           = useState<View>('list')
  const [selectedId,     setSelectedId]     = useState<string | null>(null)
  const [editSection,    setEditSection]    = useState<ReportSection | null>(null)
  const [sectionResults, setSectionResults] = useState<Record<string, SectionResult>>({})
  const [showNewDialog,  setShowNewDialog]  = useState(false)
  const [menuOpenId,     setMenuOpenId]     = useState<string | null>(null)
  const [schedulePreset, setSchedulePreset] = useState('0 9 * * *')
  const [customCron,     setCustomCron]     = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  // ── New template form state ────────────────────────────────────────────────
  const [newName,    setNewName]    = useState('')
  const [newDesc,    setNewDesc]    = useState('')
  const [newVis,     setNewVis]     = useState('private')
  const [newTeamIds, setNewTeamIds] = useState<string[]>([])

  // ── Settings form state ────────────────────────────────────────────────────
  const [settingsName,        setSettingsName]        = useState('')
  const [settingsDesc,        setSettingsDesc]        = useState('')
  const [settingsVis,         setSettingsVis]         = useState('private')
  const [settingsTeamIds,     setSettingsTeamIds]     = useState<string[]>([])
  const [settingsSched,       setSettingsSched]       = useState(false)
  const [settingsSchedCron,   setSettingsSchedCron]   = useState('0 9 * * *')
  const [settingsChanId,      setSettingsChanId]      = useState('')
  const [settingsRecipients,  setSettingsRecipients]  = useState<string[]>([])
  const [recipientInput,      setRecipientInput]      = useState('')
  const [settingsFormat,      setSettingsFormat]      = useState<'pdf' | 'excel'>('pdf')

  // Close menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpenId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data, refetch } = useQuery<{ reportTemplates: ReportTemplate[] }>(GET_REPORT_TEMPLATES, { fetchPolicy: 'network-only' })
  const { data: channelsData } = useQuery<{ notificationChannels: Channel[] }>(GET_CHANNELS_SLIM)
  const { data: teamsData }    = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS_SLIM)
  const [runExecute, { loading: execLoading, data: executeData }] = useLazyQuery<{ executeReport: { sections: SectionResult[] } }>(
    EXECUTE_REPORT, { fetchPolicy: 'network-only' },
  )

  useEffect(() => {
    if (executeData?.executeReport) {
      const map: Record<string, SectionResult> = {}
      executeData.executeReport.sections.forEach((s: SectionResult) => { map[s.sectionId] = s })
      setSectionResults(map)
    }
  }, [executeData])

  const templates: ReportTemplate[]           = data?.reportTemplates ?? []
  const channels: Channel[]                   = channelsData?.notificationChannels?.filter((c: Channel) => c.platform === 'slack') ?? []
  const teams: { id: string; name: string }[] = teamsData?.teams ?? []
  const selected: ReportTemplate | null       = templates.find((t: ReportTemplate) => t.id === selectedId) ?? null

  // ── Mutations ──────────────────────────────────────────────────────────────
  const [createTemplate, { loading: creating }] = useMutation(CREATE_REPORT_TEMPLATE)

  const [updateTemplate, { loading: updating }] = useMutation(UPDATE_REPORT_TEMPLATE, {
    onCompleted: () => { refetch(); setView('detail') },
  })

  const [deleteTemplate] = useMutation(DELETE_REPORT_TEMPLATE, {
    onCompleted: () => { refetch(); setSelectedId(null); setView('list') },
  })

  const [addSection]    = useMutation(ADD_REPORT_SECTION,    { onCompleted: () => { refetch(); setView('detail') } })
  const [updateSection] = useMutation(UPDATE_REPORT_SECTION, { onCompleted: () => { refetch(); setView('detail') } })
  const [removeSection] = useMutation(REMOVE_REPORT_SECTION, { onCompleted: () => refetch() })

  const [exportPDF,   { loading: exportingPDF }]   = useMutation<{ exportReportPDF: string }>(EXPORT_REPORT_PDF, {
    onError: (e: { message: string }) => toast.error(e.message),
  })
  const [exportExcel, { loading: exportingExcel }] = useMutation<{ exportReportExcel: string }>(EXPORT_REPORT_EXCEL, {
    onError: (e: { message: string }) => toast.error(e.message),
  })
  const [updateReportSchedule] = useMutation(UPDATE_REPORT_SCHEDULE)

  function triggerDownload(url: string) {
    const a = document.createElement('a')
    a.href = url
    a.click()
  }

  async function handleExportPDF() {
    if (!selectedId) return
    const res = await exportPDF({ variables: { templateId: selectedId } })
    if (res.data?.exportReportPDF) triggerDownload(res.data.exportReportPDF)
  }

  async function handleExportExcel() {
    if (!selectedId) return
    const res = await exportExcel({ variables: { templateId: selectedId } })
    if (res.data?.exportReportExcel) triggerDownload(res.data.exportReportExcel)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function resetNew() { setNewName(''); setNewDesc(''); setNewVis('private'); setNewTeamIds([]) }

  function openSettings(t: ReportTemplate) {
    setSettingsName(t.name)
    setSettingsDesc(t.description ?? '')
    setSettingsVis(t.visibility)
    setSettingsTeamIds(t.sharedWith.map(x => x.id))
    setSettingsSched(t.scheduleEnabled)
    setSettingsSchedCron(t.scheduleCron ?? '0 9 * * *')
    setSettingsChanId(t.scheduleChannelId ?? '')
    setSettingsRecipients(t.scheduleRecipients ?? [])
    setSettingsFormat((t.scheduleFormat as 'pdf' | 'excel') ?? 'pdf')
    setRecipientInput('')
    setMenuOpenId(null)
    setView('settings')
  }

  function goToDetail(t: ReportTemplate) {
    setSelectedId(t.id)
    setSectionResults({})
    setView('detail')
    setMenuOpenId(null)
  }

  async function duplicateTemplate(t: ReportTemplate) {
    setMenuOpenId(null)
    await createTemplate({
      variables: {
        input: {
          name:        `${t.name} (copia)`,
          description: t.description,
          icon:        t.icon ?? '📊',
          visibility:  'private',
          sharedWithTeamIds: [],
        },
      },
    })
    refetch()
  }

  function sectionToInput(s: ReportSection): ReportSectionInput {
    return {
      title: s.title, chartType: s.chartType,
      groupByNodeId: s.groupByNodeId, groupByField: s.groupByField,
      metric: s.metric, metricField: s.metricField,
      limit: s.limit, sortDir: s.sortDir,
      nodes: s.nodes.map(n => ({
        id: n.id, entityType: n.entityType, neo4jLabel: n.neo4jLabel, label: n.label,
        isResult: n.isResult, isRoot: n.isRoot,
        positionX: n.positionX, positionY: n.positionY,
        filters: n.filters, selectedFields: n.selectedFields ?? [],
      })),
      edges: s.edges.map(e => ({
        id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
        relationshipType: e.relationshipType, direction: e.direction, label: e.label,
      })),
    }
  }

  const handleAddSection = (input: ReportSectionInput) => {
    if (!selectedId) return
    addSection({ variables: { templateId: selectedId, input } })
  }

  const handleUpdateSection = (input: ReportSectionInput) => {
    if (!editSection) return
    updateSection({ variables: { sectionId: editSection.id, input } })
    setEditSection(null)
  }

  const handleSaveSettings = async () => {
    if (!selectedId) return
    const effectiveCron = schedulePreset === '__custom__' ? customCron : settingsSchedCron
    try {
      await updateTemplate({
        variables: {
          id: selectedId,
          input: {
            name:        settingsName,
            description: settingsDesc || null,
            visibility:  settingsVis,
            sharedWithTeamIds: settingsVis === 'groups' ? settingsTeamIds : [],
            scheduleEnabled:   settingsSched,
            scheduleCron:      settingsSched ? effectiveCron : null,
            scheduleChannelId: settingsSched && settingsChanId ? settingsChanId : null,
          },
        },
      })
      await updateReportSchedule({
        variables: {
          templateId: selectedId,
          enabled:    settingsSched,
          cron:       settingsSched ? effectiveCron : null,
          recipients: settingsSched ? settingsRecipients : [],
          format:     settingsFormat,
        },
      })
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Errore nel salvataggio')
    }
  }

  // ── Styles ──────────────────────────────────────────────────────────────────
  const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 10px', borderRadius: 5, border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box' }
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600 as const, color: 'var(--color-slate)', textTransform: 'uppercase' as const, marginBottom: 4, display: 'block' as const }
  const btnPrimary: React.CSSProperties = { padding: '8px 18px', borderRadius: 7, border: 'none', background: 'var(--color-brand)', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600 }
  const btnGhost: React.CSSProperties  = { padding: '8px 14px', borderRadius: 7, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 14, color: 'var(--color-slate)' }

  // ── RENDER ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f8fafc' }}>

      {/* ════════════════════════════════════════════════════════════════════
          LIST VIEW
      ════════════════════════════════════════════════════════════════════ */}
      {view === 'list' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
            <div>
              <PageTitle icon={<LayoutGrid size={22} color="var(--color-brand)" />}>
                {tr('pages.reportBuilder.title')}
              </PageTitle>
              <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
                {tr('pages.reportBuilder.count', { count: templates.length })}
              </p>
            </div>
            <button
              onClick={() => setShowNewDialog(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', backgroundColor: '#38bdf8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms' }}
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
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-slate-dark)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                      {/* ⋮ Menu */}
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <button
                          onClick={e => { e.stopPropagation(); setMenuOpenId(isMenuOpen ? null : t.id) }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 5px', fontSize: 14, color: 'var(--color-slate-light)', lineHeight: 1, borderRadius: 4 }}
                        >⋮</button>
                        {isMenuOpen && (
                          <div style={{
                            position: 'absolute', top: '100%', right: 0, zIndex: 50,
                            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
                            boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 180, overflow: 'hidden',
                          }}>
                            {[
                              { label: '⚙ Modifica impostazioni', action: () => { setSelectedId(t.id); openSettings(t) } },
                              { label: '⧉ Duplica',               action: () => duplicateTemplate(t) },
                              { label: '🗑 Elimina',              action: () => { if (confirm('Eliminare il report?')) deleteTemplate({ variables: { id: t.id } }); setMenuOpenId(null) }, danger: true },
                            ].map(item => (
                              <button key={item.label} onClick={item.action} style={{
                                display: 'block', width: '100%', textAlign: 'left',
                                padding: '10px 14px', border: 'none', background: 'none',
                                cursor: 'pointer', fontSize: 14,
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
                      <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: vc.bg, color: vc.fg }}>
                        {VIS_LABELS[t.visibility] ?? t.visibility}
                      </span>
                      {t.createdBy && (
                        <span style={{ fontSize: 10, color: 'var(--color-slate-light)' }}>· {t.createdBy.name}</span>
                      )}
                    </div>
                  </div>

                  {/* Card footer */}
                  <div style={{ padding: '8px 14px', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => { setSelectedId(t.id); setSectionResults({}); runExecute({ variables: { templateId: t.id } }); goToDetail(t) }}
                      style={{ ...btnGhost, flex: 1, fontSize: 12, padding: '4px 10px' }}
                    >▶ {tr('pages.reportBuilder.execute')}</button>
                    <button
                      onClick={() => goToDetail(t)}
                      style={{ ...btnPrimary, flex: 1, fontSize: 12, padding: '4px 10px' }}
                    >✏ {tr('pages.reportBuilder.modify')}</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          DETAIL VIEW
      ════════════════════════════════════════════════════════════════════ */}
      {view === 'detail' && selected && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ padding: '12px 32px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <button onClick={() => setView('list')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              ← Tutti i report
            </button>
            <span style={{ display: 'flex', alignItems: 'center' }}>{getReportIcon(selected)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 18, color: 'var(--color-slate-dark)' }}>{selected.name}</div>
              {selected.description && <div style={{ fontSize: 12, color: 'var(--color-slate)' }}>{selected.description}</div>}
            </div>
            <button onClick={() => openSettings(selected)} style={{ ...btnGhost, fontSize: 12 }}>⚙ Impostazioni</button>
            <button
              onClick={() => { setSectionResults({}); runExecute({ variables: { templateId: selected.id } }) }}
              disabled={execLoading}
              style={{ ...btnGhost, fontSize: 12 }}
            >{execLoading ? tr('common.loading') : `▶ ${tr('pages.reportBuilder.execute')}`}</button>
            <button onClick={() => void handleExportPDF()} disabled={exportingPDF} style={{ ...btnGhost, fontSize: 12 }}>
              {exportingPDF ? '…' : '↓ PDF'}
            </button>
            <button onClick={() => void handleExportExcel()} disabled={exportingExcel} style={{ ...btnGhost, fontSize: 12 }}>
              {exportingExcel ? '…' : '↓ Excel'}
            </button>
            <button onClick={() => setView('add-section')} style={btnPrimary}>+ Sezione</button>
          </div>

          {/* Sections */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            {selected.sections.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 14, paddingTop: 60 }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
                Nessuna sezione. Clicca "+ Sezione" per iniziare.
              </div>
            )}
            {[...selected.sections].sort((a, b) => a.order - b.order).map(sec => {
              const result = sectionResults[sec.id]
              return (
                <div key={sec.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
                  <div style={{ padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-slate-dark)' }}>{sec.title}</span>
                      <span style={{ fontSize: 12, color: 'var(--color-slate)', background: '#e5e7eb', padding: '2px 6px', borderRadius: 4 }}>{sec.chartType}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => { setEditSection(sec); setView('edit-section') }}
                        style={{ ...btnGhost, padding: '4px 10px', fontSize: 12 }}>✏ Modifica sezione</button>
                      <button onClick={() => { if (confirm('Rimuovere la sezione?')) removeSection({ variables: { templateId: selected.id, sectionId: sec.id } }) }}
                        style={{ ...btnGhost, padding: '4px 10px', fontSize: 12, color: 'var(--color-trigger-sla-breach)' }}>🗑</button>
                    </div>
                  </div>
                  <div style={{ padding: 16 }}>
                    {result ? (
                      <ReportChartRenderer chartType={result.chartType} data={result.data} title={result.title} error={result.error} />
                    ) : (
                      <div style={{ textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 14, padding: 24 }}>
                        Clicca "▶ Esegui" per caricare i dati
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          ADD SECTION
      ════════════════════════════════════════════════════════════════════ */}
      {view === 'add-section' && selected && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 32px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <button onClick={() => setView('detail')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 12 }}>← Indietro</button>
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-slate-dark)' }}>Aggiungi sezione — {selected.name}</span>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ReportSectionBuilder onSave={handleAddSection} onCancel={() => setView('detail')} />
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          EDIT SECTION
      ════════════════════════════════════════════════════════════════════ */}
      {view === 'edit-section' && selected && editSection && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 32px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <button onClick={() => { setView('detail'); setEditSection(null) }} style={{ ...btnGhost, padding: '6px 12px', fontSize: 12 }}>← Indietro</button>
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-slate-dark)' }}>Modifica sezione: {editSection.title}</span>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ReportSectionBuilder
              initialValues={sectionToInput(editSection)}
              onSave={handleUpdateSection}
              onCancel={() => { setView('detail'); setEditSection(null) }}
            />
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          SETTINGS
      ════════════════════════════════════════════════════════════════════ */}
      {view === 'settings' && selected && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
              <button onClick={() => setView('detail')} style={{ ...btnGhost, padding: '6px 12px', fontSize: 12 }}>← Indietro</button>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Impostazioni — {selected.name}</h2>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Nome</label>
              <input value={settingsName} onChange={e => setSettingsName(e.target.value)} style={inputStyle} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Descrizione</label>
              <textarea value={settingsDesc} onChange={e => setSettingsDesc(e.target.value)} style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Visibilità</label>
              <select value={settingsVis} onChange={e => setSettingsVis(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
                <option value="private">Privato</option>
                <option value="groups">Gruppi selezionati</option>
                <option value="all">Tutti</option>
              </select>
            </div>

            {settingsVis === 'groups' && teams.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Condividi con team</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {teams.map((team: { id: string; name: string }) => (
                    <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, cursor: 'pointer' }}>
                      <input type="checkbox" checked={settingsTeamIds.includes(team.id)}
                        onChange={e => setSettingsTeamIds(prev => e.target.checked ? [...prev, team.id] : prev.filter((x: string) => x !== team.id))} />
                      {team.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 20, padding: 16, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: settingsSched ? 14 : 0 }}>
                <input type="checkbox" checked={settingsSched} onChange={e => setSettingsSched(e.target.checked)} />
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-slate-dark)' }}>Abilita schedulazione</span>
              </label>
              {settingsSched && (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <label style={labelStyle}>Frequenza</label>
                    <select value={schedulePreset}
                      onChange={e => { setSchedulePreset(e.target.value); if (e.target.value !== '__custom__') setSettingsSchedCron(e.target.value) }}
                      style={{ ...inputStyle, background: '#fff' }}>
                      {SCHEDULE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                  {schedulePreset === '__custom__' && (
                    <div style={{ marginBottom: 10 }}>
                      <label style={labelStyle}>Espressione cron</label>
                      <input value={customCron} onChange={e => { setCustomCron(e.target.value); setSettingsSchedCron(e.target.value) }}
                        style={inputStyle} placeholder="0 9 * * *" />
                    </div>
                  )}
                  {channels.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <label style={labelStyle}>Canale Slack</label>
                      <select value={settingsChanId} onChange={e => setSettingsChanId(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
                        <option value="">Nessun canale</option>
                        {channels.map((c: Channel) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Recipients */}
                  <div style={{ marginBottom: 10 }}>
                    <label style={labelStyle}>Destinatari email</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', minHeight: 38 }}>
                      {settingsRecipients.map((r) => (
                        <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: '#e0f2fe', color: '#0369a1', fontSize: 12, fontWeight: 500 }}>
                          {r}
                          <button onClick={() => setSettingsRecipients(prev => prev.filter(x => x !== r))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: '#0369a1', fontWeight: 600 }}>×</button>
                        </span>
                      ))}
                      <input
                        value={recipientInput}
                        onChange={e => setRecipientInput(e.target.value)}
                        onKeyDown={e => {
                          if ((e.key === 'Enter' || e.key === ',') && recipientInput.trim()) {
                            e.preventDefault()
                            const email = recipientInput.trim().replace(/,$/, '')
                            if (email && !settingsRecipients.includes(email)) {
                              setSettingsRecipients(prev => [...prev, email])
                            }
                            setRecipientInput('')
                          } else if (e.key === 'Backspace' && !recipientInput && settingsRecipients.length > 0) {
                            setSettingsRecipients(prev => prev.slice(0, -1))
                          }
                        }}
                        placeholder={settingsRecipients.length === 0 ? 'email@esempio.com, Enter' : ''}
                        style={{ flex: 1, minWidth: 160, border: 'none', outline: 'none', fontSize: 13, background: 'transparent' }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 3 }}>
                      Premi Invio o virgola per aggiungere. (Email SMTP non ancora implementato — archiviato per uso futuro.)
                    </div>
                  </div>

                  {/* Format */}
                  <div>
                    <label style={labelStyle}>Formato report</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['pdf', 'excel'] as const).map((fmt) => (
                        <label key={fmt} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: `1px solid ${settingsFormat === fmt ? '#0284c7' : '#d1d5db'}`, background: settingsFormat === fmt ? '#f0f9ff' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: settingsFormat === fmt ? 600 : 400, color: settingsFormat === fmt ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                          <input type="radio" name="schedFormat" value={fmt} checked={settingsFormat === fmt} onChange={() => setSettingsFormat(fmt)} style={{ margin: 0 }} />
                          {fmt === 'pdf' ? '📄 PDF' : '📊 Excel'}
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Last run */}
                  {selected.lastScheduledRun && (
                    <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-slate-light)' }}>
                      Ultima esecuzione: {new Date(selected.lastScheduledRun).toLocaleString('it-IT')}
                    </div>
                  )}
                </>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => void handleSaveSettings()} disabled={updating} style={btnPrimary}>
                {updating ? 'Salvataggio...' : 'Salva impostazioni'}
              </button>
              <button onClick={() => setView('detail')} style={btnGhost}>Annulla</button>
            </div>
          </div>
        </div>
      )}

      {/* ── New template dialog ────────────────────────────────────────────────── */}
      {showNewDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 20, color: 'var(--color-slate-dark)' }}>Nuovo report</div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Nome *</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} style={inputStyle} placeholder="Nome report..." />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Descrizione</label>
              <textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Visibilità</label>
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
                    <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, cursor: 'pointer' }}>
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
              <button disabled={!newName || creating} onClick={async () => {
                const result = await createTemplate({ variables: { input: { name: newName, description: newDesc || null, visibility: newVis, sharedWithTeamIds: newVis === 'groups' ? newTeamIds : [] } } }).catch(() => null)
                const id = (result?.data as { createReportTemplate: { id: string } } | undefined)?.createReportTemplate?.id
                await refetch()
                if (id) { setSelectedId(id); setView('detail') }
                setShowNewDialog(false); resetNew()
              }} style={{ ...btnPrimary, opacity: !newName || creating ? 0.6 : 1 }}>
                {creating ? 'Creazione...' : 'Crea report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
