import { useState, useEffect } from 'react'
import { useQuery, useMutation, useLazyQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
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
} from '@/graphql/mutations'
import { ReportChartRenderer } from '@/components/ReportChartRenderer'
import { ReportSectionBuilder, type ReportSectionInput } from '@/components/ReportSectionBuilder'

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReportNode { id: string; entityType: string; neo4jLabel: string; label: string; isResult: boolean; isRoot: boolean; positionX: number; positionY: number; filters: string | null; selectedFields: string[] }
interface ReportEdge { id: string; sourceNodeId: string; targetNodeId: string; relationshipType: string; direction: string; label: string }
interface ReportSection { id: string; order: number; title: string; chartType: string; groupByNodeId: string | null; groupByField: string | null; metric: string; metricField: string | null; limit: number | null; sortDir: string | null; nodes: ReportNode[]; edges: ReportEdge[] }
interface ReportTemplate { id: string; name: string; description: string | null; icon: string | null; visibility: string; scheduleEnabled: boolean; scheduleCron: string | null; scheduleChannelId?: string | null; createdAt: string; createdBy: { id: string; name: string } | null; sharedWith: { id: string; name: string }[]; sections: ReportSection[] }
interface Channel { id: string; name: string; platform: string }
interface SectionResult { sectionId: string; title: string; chartType: string; data: string; total: number | null; error: string | null }

const GET_CHANNELS_SLIM = gql`query GetChannelsSlim { notificationChannels { id name platform } }`
const GET_TEAMS_SLIM    = gql`query GetTeamsSlim { teams { id name } }`

type Mode = 'view' | 'add-section' | 'edit-section' | 'settings'

const SCHEDULE_PRESETS = [
  { label: 'Ogni giorno alle 9:00',      value: '0 9 * * *' },
  { label: 'Ogni lunedì alle 9:00',      value: '0 9 * * 1' },
  { label: 'Ogni primo del mese alle 9', value: '0 9 1 * *' },
  { label: 'Personalizzata',             value: '__custom__' },
]

const ICONS = ['📊', '📈', '📋', '🔢', '🥧', '⚙️', '🎯', '💡']
const VIS_LABELS: Record<string, string> = { private: 'Privato', groups: 'Gruppi', all: 'Tutti' }

// ── Page ───────────────────────────────────────────────────────────────────────

export function CustomReportsPage() {
  const [selectedId,      setSelectedId]      = useState<string | null>(null)
  const [mode,            setMode]            = useState<Mode>('view')
  const [editSection,     setEditSection]     = useState<ReportSection | null>(null)
  const [sectionResults,  setSectionResults]  = useState<Record<string, SectionResult>>({})
  const [showNewDialog,   setShowNewDialog]   = useState(false)
  const [schedulePreset,  setSchedulePreset]  = useState('0 9 * * *')
  const [customCron,      setCustomCron]      = useState('')

  // ── New template form state ────────────────────────────────────────────────
  const [newName,       setNewName]       = useState('')
  const [newDesc,       setNewDesc]       = useState('')
  const [newIcon,       setNewIcon]       = useState('📊')
  const [newVis,        setNewVis]        = useState('private')
  const [newTeamIds,    setNewTeamIds]    = useState<string[]>([])

  // ── Settings form state ────────────────────────────────────────────────────
  const [settingsName,      setSettingsName]      = useState('')
  const [settingsDesc,      setSettingsDesc]      = useState('')
  const [settingsIcon,      setSettingsIcon]      = useState('📊')
  const [settingsVis,       setSettingsVis]       = useState('private')
  const [settingsTeamIds,   setSettingsTeamIds]   = useState<string[]>([])
  const [settingsSched,     setSettingsSched]      = useState(false)
  const [settingsSchedCron, setSettingsSchedCron] = useState('0 9 * * *')
  const [settingsChanId,    setSettingsChanId]    = useState('')

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data, refetch } = useQuery<{ reportTemplates: ReportTemplate[] }>(GET_REPORT_TEMPLATES, { fetchPolicy: 'network-only' })
  const { data: channelsData } = useQuery<{ notificationChannels: Channel[] }>(GET_CHANNELS_SLIM)
  const { data: teamsData }    = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS_SLIM)
  const [runExecute, { loading: execLoading, data: executeData }] = useLazyQuery<{ executeReport: { sections: SectionResult[] } }>(
    EXECUTE_REPORT,
    { fetchPolicy: 'network-only' },
  )

  useEffect(() => {
    if (executeData?.executeReport) {
      const map: Record<string, SectionResult> = {}
      executeData.executeReport.sections.forEach((s: SectionResult) => { map[s.sectionId] = s })
      setSectionResults(map)
    }
  }, [executeData])

  const templates: ReportTemplate[]                   = data?.reportTemplates ?? []
  const channels: Channel[]                            = channelsData?.notificationChannels?.filter((c: Channel) => c.platform === 'slack') ?? []
  const teams: { id: string; name: string }[]         = teamsData?.teams ?? []
  const selected: ReportTemplate | null                = templates.find((t: ReportTemplate) => t.id === selectedId) ?? null

  // ── Mutations ──────────────────────────────────────────────────────────────
  const [createTemplate, { loading: creating }] = useMutation(CREATE_REPORT_TEMPLATE)

  const [updateTemplate, { loading: updating }] = useMutation(UPDATE_REPORT_TEMPLATE, {
    onCompleted: () => { refetch(); setMode('view') },
  })

  const [deleteTemplate] = useMutation(DELETE_REPORT_TEMPLATE, {
    onCompleted: () => { refetch(); setSelectedId(null) },
  })

  const [addSection]    = useMutation(ADD_REPORT_SECTION,    { onCompleted: () => { refetch(); setMode('view') } })
  const [updateSection] = useMutation(UPDATE_REPORT_SECTION, { onCompleted: () => { refetch(); setMode('view') } })
  const [removeSection] = useMutation(REMOVE_REPORT_SECTION, { onCompleted: () => refetch() })

  // ── Helpers ────────────────────────────────────────────────────────────────

  function resetNew() { setNewName(''); setNewDesc(''); setNewIcon('📊'); setNewVis('private'); setNewTeamIds([]) }

  function openSettings(t: ReportTemplate) {
    setSettingsName(t.name)
    setSettingsDesc(t.description ?? '')
    setSettingsIcon(t.icon ?? '📊')
    setSettingsVis(t.visibility)
    setSettingsTeamIds(t.sharedWith.map(x => x.id))
    setSettingsSched(t.scheduleEnabled)
    setSettingsSchedCron(t.scheduleCron ?? '0 9 * * *')
    setSettingsChanId(t.scheduleChannelId ?? '')
    setMode('settings')
  }

  function sectionToInput(s: ReportSection): ReportSectionInput {
    return {
      title:         s.title,
      chartType:     s.chartType,
      groupByNodeId: s.groupByNodeId,
      groupByField:  s.groupByField,
      metric:        s.metric,
      metricField:   s.metricField,
      limit:         s.limit,
      sortDir:       s.sortDir,
      nodes: s.nodes.map(n => ({
        id:             n.id,
        entityType:     n.entityType,
        neo4jLabel:     n.neo4jLabel,
        label:          n.label,
        isResult:       n.isResult,
        isRoot:         n.isRoot,
        positionX:      n.positionX,
        positionY:      n.positionY,
        filters:        n.filters,
        selectedFields: n.selectedFields ?? [],
      })),
      edges: s.edges.map(e => ({
        id:               e.id,
        sourceNodeId:     e.sourceNodeId,
        targetNodeId:     e.targetNodeId,
        relationshipType: e.relationshipType,
        direction:        e.direction,
        label:            e.label,
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

  const handleSaveSettings = () => {
    if (!selectedId) return
    const effectiveCron = schedulePreset === '__custom__' ? customCron : settingsSchedCron
    updateTemplate({
      variables: {
        id: selectedId,
        input: {
          name:              settingsName,
          description:       settingsDesc || null,
          icon:              settingsIcon,
          visibility:        settingsVis,
          sharedWithTeamIds: settingsVis === 'groups' ? settingsTeamIds : [],
          scheduleEnabled:   settingsSched,
          scheduleCron:      settingsSched ? effectiveCron : null,
          scheduleChannelId: settingsSched && settingsChanId ? settingsChanId : null,
        },
      },
    })
  }

  // ── Styles ──────────────────────────────────────────────────────────────────
  const inputStyle: React.CSSProperties  = { width: '100%', padding: '6px 10px', borderRadius: 5, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }
  const labelStyle: React.CSSProperties  = { fontSize: 11, fontWeight: 600 as const, color: '#6b7280', textTransform: 'uppercase' as const, marginBottom: 4, display: 'block' as const }
  const btnPrimary: React.CSSProperties  = { padding: '7px 16px', borderRadius: 6, border: 'none', background: '#4f46e5', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
  const btnGhost: React.CSSProperties   = { padding: '7px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── LEFT: template list ─────────────────────────────────────────────── */}
      <div style={{
        width: 300, flexShrink: 0, borderRight: '1px solid #e5e7eb',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 14px 10px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#0f1629' }}>Report</span>
          <button onClick={() => setShowNewDialog(true)} style={btnPrimary}>+ Nuovo</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
          {templates.map((t: ReportTemplate) => (
            <div key={t.id} onClick={() => { setSelectedId(t.id); setMode('view'); setSectionResults({}) }}
              style={{
                padding: 12, borderRadius: 8, marginBottom: 6, cursor: 'pointer',
                background: selectedId === t.id ? '#eef2ff' : '#fafafa',
                border: `1px solid ${selectedId === t.id ? '#c7d2fe' : '#e5e7eb'}`,
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 18 }}>{t.icon ?? '📊'}</span>
                <span style={{ fontWeight: 600, fontSize: 13, color: '#111827', flex: 1 }}>{t.name}</span>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                  background: t.visibility === 'all' ? '#dcfce7' : t.visibility === 'groups' ? '#fef3c7' : '#f3f4f6',
                  color:      t.visibility === 'all' ? '#15803d' : t.visibility === 'groups' ? '#92400e' : '#6b7280',
                }}>
                  {VIS_LABELS[t.visibility] ?? t.visibility}
                </span>
              </div>
              {t.createdBy && <div style={{ fontSize: 11, color: '#9ca3af' }}>Da: {t.createdBy.name}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button onClick={e => { e.stopPropagation(); setSelectedId(t.id); runExecute({ variables: { templateId: t.id } }) }}
                  style={{ ...btnGhost, padding: '3px 10px', fontSize: 11 }}>▶ Esegui</button>
                <button onClick={e => { e.stopPropagation(); setSelectedId(t.id); openSettings(t) }}
                  style={{ ...btnGhost, padding: '3px 10px', fontSize: 11 }}>✏ Modifica</button>
                <button onClick={e => { e.stopPropagation(); if (confirm('Eliminare il report?')) deleteTemplate({ variables: { id: t.id } }) }}
                  style={{ ...btnGhost, padding: '3px 10px', fontSize: 11, color: '#dc2626', borderColor: '#fecaca' }}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── RIGHT: content ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Empty state */}
        {!selected && mode !== 'settings' && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 40 }}>📊</span>
            <span style={{ fontSize: 14 }}>Seleziona o crea un report</span>
          </div>
        )}

        {/* VIEW mode */}
        {selected && mode === 'view' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
              <span style={{ fontSize: 24 }}>{selected.icon ?? '📊'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#0f1629' }}>{selected.name}</div>
                {selected.description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{selected.description}</div>}
              </div>
              <button onClick={() => { setSectionResults({}); runExecute({ variables: { templateId: selected.id } }) }}
                disabled={execLoading} style={{ ...btnGhost, fontSize: 12 }}>
                {execLoading ? 'Caricamento...' : '▶ Aggiorna dati'}
              </button>
              <button onClick={() => setMode('add-section')} style={btnPrimary}>+ Aggiungi sezione</button>
              <button onClick={() => openSettings(selected)} style={{ ...btnGhost, fontSize: 12 }}>⚙ Impostazioni</button>
            </div>

            {/* Sections */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {selected.sections.length === 0 && (
                <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: 14, paddingTop: 40 }}>
                  Nessuna sezione. Clicca "+ Aggiungi sezione" per iniziare.
                </div>
              )}
              {[...selected.sections].sort((a, b) => a.order - b.order).map(sec => {
                const result = sectionResults[sec.id]
                return (
                  <div key={sec.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{sec.title}</span>
                        <span style={{ fontSize: 11, color: '#6b7280', background: '#e5e7eb', padding: '2px 6px', borderRadius: 4 }}>{sec.chartType}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => { setEditSection(sec); setMode('edit-section') }}
                          style={{ ...btnGhost, padding: '4px 10px', fontSize: 12 }}>✏</button>
                        <button onClick={() => { if (confirm('Rimuovere la sezione?')) removeSection({ variables: { templateId: selected.id, sectionId: sec.id } }) }}
                          style={{ ...btnGhost, padding: '4px 10px', fontSize: 12, color: '#dc2626' }}>🗑</button>
                      </div>
                    </div>
                    <div style={{ padding: 16 }}>
                      {result ? (
                        <ReportChartRenderer chartType={result.chartType} data={result.data} title={result.title} error={result.error} />
                      ) : (
                        <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: 24 }}>
                          Clicca "▶ Aggiorna dati" per caricare
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ADD SECTION mode */}
        {selected && mode === 'add-section' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, fontSize: 14, color: '#0f1629', flexShrink: 0 }}>
              Aggiungi sezione
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              <ReportSectionBuilder
                onSave={handleAddSection}
                onCancel={() => setMode('view')}
              />
            </div>
          </div>
        )}

        {/* EDIT SECTION mode */}
        {selected && mode === 'edit-section' && editSection && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, fontSize: 14, color: '#0f1629', flexShrink: 0 }}>
              Modifica sezione: {editSection.title}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              <ReportSectionBuilder
                initialValues={sectionToInput(editSection)}
                onSave={handleUpdateSection}
                onCancel={() => { setMode('view'); setEditSection(null) }}
              />
            </div>
          </div>
        )}

        {/* SETTINGS mode */}
        {selected && mode === 'settings' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
            <div style={{ maxWidth: 520 }}>
              <div style={{ fontWeight: 700, fontSize: 16, color: '#0f1629', marginBottom: 20 }}>Impostazioni report</div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Icona</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {ICONS.map(ic => (
                    <button key={ic} onClick={() => setSettingsIcon(ic)} style={{
                      width: 40, height: 40, fontSize: 20, borderRadius: 6, cursor: 'pointer',
                      border: `2px solid ${settingsIcon === ic ? '#4f46e5' : '#e5e7eb'}`,
                      background: settingsIcon === ic ? '#eef2ff' : '#fff',
                    }}>{ic}</button>
                  ))}
                </div>
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
                      <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="checkbox" checked={settingsTeamIds.includes(team.id)}
                          onChange={e => setSettingsTeamIds(prev => e.target.checked ? [...prev, team.id] : prev.filter((x: string) => x !== team.id))} />
                        {team.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 14, padding: 16, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: settingsSched ? 14 : 0 }}>
                  <input type="checkbox" checked={settingsSched} onChange={e => setSettingsSched(e.target.checked)} />
                  <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>Abilita schedulazione</span>
                </label>

                {settingsSched && (
                  <>
                    <div style={{ marginBottom: 10 }}>
                      <label style={labelStyle}>Frequenza</label>
                      <select value={schedulePreset} onChange={e => { setSchedulePreset(e.target.value); if (e.target.value !== '__custom__') setSettingsSchedCron(e.target.value) }}
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
                      <div>
                        <label style={labelStyle}>Canale Slack</label>
                        <select value={settingsChanId} onChange={e => setSettingsChanId(e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
                          <option value="">Nessun canale</option>
                          {channels.map((c: Channel) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={handleSaveSettings} disabled={updating} style={btnPrimary}>
                  {updating ? 'Salvataggio...' : 'Salva impostazioni'}
                </button>
                <button onClick={() => setMode('view')} style={btnGhost}>Annulla</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── New template dialog ─────────────────────────────────────────────── */}
      {showNewDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20, color: '#0f1629' }}>Nuovo report</div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Icona</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {ICONS.map(ic => (
                  <button key={ic} onClick={() => setNewIcon(ic)} style={{ width: 36, height: 36, fontSize: 18, borderRadius: 6, cursor: 'pointer', border: `2px solid ${newIcon === ic ? '#4f46e5' : '#e5e7eb'}`, background: newIcon === ic ? '#eef2ff' : '#fff' }}>{ic}</button>
                ))}
              </div>
            </div>
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
                    <label key={team.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
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
                const formValues = { name: newName, description: newDesc || null, icon: newIcon, visibility: newVis, sharedWithTeamIds: newVis === 'groups' ? newTeamIds : [] }
                console.log('[CREATE]', formValues)
                const result = await createTemplate({ variables: { input: formValues } }).catch((err: unknown) => { console.error('[CREATE error]', err); return null })
                console.log('[CREATE result]', result?.data, result?.error)
                const id = (result?.data as { createReportTemplate: { id: string } } | undefined)?.createReportTemplate?.id
                if (id) setSelectedId(id)
                refetch(); setShowNewDialog(false); resetNew()
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
