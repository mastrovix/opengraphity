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
import { toast } from 'sonner'
import type { ReportSectionInput } from '@/components/ReportSectionBuilder'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ReportNode { id: string; entityType: string; neo4jLabel: string; label: string; isResult: boolean; isRoot: boolean; positionX: number; positionY: number; filters: string | null; selectedFields: string[] }
export interface ReportEdge { id: string; sourceNodeId: string; targetNodeId: string; relationshipType: string; direction: string; label: string }
export interface ReportSection { id: string; order: number; title: string; chartType: string; groupByNodeId: string | null; groupByField: string | null; metric: string; metricField: string | null; limit: number | null; sortDir: string | null; nodes: ReportNode[]; edges: ReportEdge[] }
export interface ReportTemplate { id: string; name: string; description: string | null; icon: string | null; visibility: string; scheduleEnabled: boolean; scheduleCron: string | null; scheduleChannelId?: string | null; scheduleRecipients: string[]; scheduleFormat: string | null; lastScheduledRun: string | null; createdAt: string; updatedAt?: string; createdBy: { id: string; name: string } | null; sharedWith: { id: string; name: string }[]; sections: ReportSection[] }
export interface Channel { id: string; name: string; platform: string }
export interface SectionResult { sectionId: string; title: string; chartType: string; data: string; total: number | null; error: string | null }

export type View = 'list' | 'detail' | 'add-section' | 'edit-section' | 'settings'

export const SCHEDULE_PRESETS = [
  { label: 'Ogni giorno alle 9:00',      value: '0 9 * * *' },
  { label: 'Ogni lunedì alle 9:00',      value: '0 9 * * 1' },
  { label: 'Ogni primo del mese alle 9', value: '0 9 1 * *' },
  { label: 'Personalizzata',             value: '__custom__' },
]

export const VIS_LABELS: Record<string, string> = { private: 'Privato', groups: 'Gruppi', all: 'Tutti' }
export const VIS_COLORS: Record<string, { bg: string; fg: string }> = {
  all:     { bg: '#dcfce7', fg: '#15803d' },
  groups:  { bg: '#fef3c7', fg: '#92400e' },
  private: { bg: '#f3f4f6', fg: 'var(--color-slate)' },
}

const GET_CHANNELS_SLIM = gql`query GetChannelsSlim { notificationChannels { id name platform } }`
const GET_TEAMS_SLIM    = gql`query GetTeamsSlim { teams { id name } }`

// ── Styles (shared) ────────────────────────────────────────────────────────────

export const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 10px', borderRadius: 5, border: '1px solid #d1d5db', fontSize: 'var(--font-size-body)', boxSizing: 'border-box' }
export const labelStyle: React.CSSProperties = { fontSize: 'var(--font-size-body)', fontWeight: 600 as const, color: 'var(--color-slate)', textTransform: 'uppercase' as const, marginBottom: 4, display: 'block' as const }
export const btnPrimary: React.CSSProperties = { padding: '8px 18px', borderRadius: 7, border: 'none', background: 'var(--color-brand)', color: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 600 }
export const btnGhost: React.CSSProperties  = { padding: '8px 14px', borderRadius: 7, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useCustomReports() {
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

  async function handleCreateTemplate() {
    const result = await createTemplate({ variables: { input: { name: newName, description: newDesc || null, visibility: newVis, sharedWithTeamIds: newVis === 'groups' ? newTeamIds : [] } } }).catch(() => null)
    const id = (result?.data as { createReportTemplate: { id: string } } | undefined)?.createReportTemplate?.id
    await refetch()
    if (id) { setSelectedId(id); setView('detail') }
    setShowNewDialog(false); resetNew()
  }

  function handleDeleteTemplate(id: string) {
    if (confirm('Eliminare il report?')) deleteTemplate({ variables: { id } })
    setMenuOpenId(null)
  }

  function handleRemoveSection(templateId: string, sectionId: string) {
    if (confirm('Rimuovere la sezione?')) removeSection({ variables: { templateId, sectionId } })
  }

  function handleExecuteAndGoToDetail(t: ReportTemplate) {
    setSelectedId(t.id)
    setSectionResults({})
    runExecute({ variables: { templateId: t.id } })
    goToDetail(t)
  }

  function handleExecuteSelected() {
    if (!selected) return
    setSectionResults({})
    runExecute({ variables: { templateId: selected.id } })
  }

  function startEditSection(sec: ReportSection) {
    setEditSection(sec)
    setView('edit-section')
  }

  function cancelEditSection() {
    setView('detail')
    setEditSection(null)
  }

  return {
    tr,
    // View state
    view, setView,
    selected, selectedId, setSelectedId,
    editSection, setEditSection,
    sectionResults,
    menuRef,
    // Templates & data
    templates, channels, teams,
    // Loading states
    execLoading, creating, updating, exportingPDF, exportingExcel,
    // New dialog state
    showNewDialog, setShowNewDialog,
    newName, setNewName,
    newDesc, setNewDesc,
    newVis, setNewVis,
    newTeamIds, setNewTeamIds,
    // Menu
    menuOpenId, setMenuOpenId,
    // Settings state
    settingsName, setSettingsName,
    settingsDesc, setSettingsDesc,
    settingsVis, setSettingsVis,
    settingsTeamIds, setSettingsTeamIds,
    settingsSched, setSettingsSched,
    settingsSchedCron, setSettingsSchedCron,
    settingsChanId, setSettingsChanId,
    settingsRecipients, setSettingsRecipients,
    recipientInput, setRecipientInput,
    settingsFormat, setSettingsFormat,
    schedulePreset, setSchedulePreset,
    customCron, setCustomCron,
    // Handlers
    openSettings,
    goToDetail,
    duplicateTemplate,
    sectionToInput,
    handleAddSection,
    handleUpdateSection,
    handleSaveSettings,
    handleExportPDF,
    handleExportExcel,
    handleCreateTemplate,
    handleDeleteTemplate,
    handleRemoveSection,
    handleExecuteAndGoToDetail,
    handleExecuteSelected,
    startEditSection,
    cancelEditSection,
    resetNew,
  }
}

export type UseCustomReportsReturn = ReturnType<typeof useCustomReports>
