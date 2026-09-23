import { useState, useEffect, useRef } from 'react'
import { useConfirm } from '@/hooks/useConfirm'
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
  DUPLICATE_REPORT_TEMPLATE,
  ADD_REPORT_SECTION,
  UPDATE_REPORT_SECTION,
  REMOVE_REPORT_SECTION,
  EXPORT_REPORT_PDF,
  EXPORT_REPORT_EXCEL,
  UPDATE_REPORT_SCHEDULE,
} from '@/graphql/mutations'
import { toast } from 'sonner'
import { downloadFile } from '@/lib/downloadPdf'
import type { ReportSectionInput } from '@/components/ReportSectionBuilder'
import { colors, palette } from '@/lib/tokens'
import { showError } from '@/lib/showError'
import { reloadQueries } from '@/lib/reloadQueries'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ReportNode { id: string; entityType: string; neo4jLabel: string; label: string; isResult: boolean; isRoot: boolean; positionX: number; positionY: number; filters: string | null; selectedFields: string[] }
export interface ReportEdge { id: string; sourceNodeId: string; targetNodeId: string; relationshipType: string; direction: string; label: string }
export interface ReportSection { id: string; order: number; title: string; chartType: string; groupByNodeId: string | null; groupByField: string | null; groupByGranularity: string | null; metric: string; metricField: string | null; limit: number | null; sortDir: string | null; nodes: ReportNode[]; edges: ReportEdge[] }
export interface ReportTemplate { id: string; name: string; description: string | null; icon: string | null; visibility: string; scheduleEnabled: boolean; scheduleCron: string | null; scheduleChannelId?: string | null; scheduleRecipients: string[]; scheduleFormat: string | null; lastScheduledRun: string | null; createdAt: string; updatedAt?: string; createdBy: { id: string; name: string } | null; sharedWith: { id: string; name: string }[]; sections: ReportSection[] }
export interface Channel { id: string; name: string; platform: string }
// `errorKey` c'era nella query e NON nel tipo: la pagina non poteva
// passarla al renderer nemmeno volendo, e ogni errore di sezione si leggeva
// in inglese (20 set 2026).
export interface SectionResult { sectionId: string; title: string; chartType: string; data: string; total: number | null; error: string | null; errorKey: string | null }

export type View = 'list' | 'detail' | 'add-section' | 'edit-section' | 'settings'

/*
  CHIAVI, non etichette. Erano frasi italiane in un file `.ts`, che nessun
  guardiano dell'i18n vede — non c'e JSX — e finivano a schermo cosi come
  sono: in un'interfaccia inglese si leggeva «Ogni lunedi alle 9:00».
*/
export const SCHEDULE_PRESETS = [
  { labelKey: 'pages.reportSchedule.preset.dailyAt9',   value: '0 9 * * *' },
  { labelKey: 'pages.reportSchedule.preset.mondayAt9',  value: '0 9 * * 1' },
  { labelKey: 'pages.reportSchedule.preset.monthlyAt9', value: '0 9 1 * *' },
  { labelKey: 'pages.reportSchedule.preset.custom',     value: '__custom__' },
]

export const VIS_LABEL_KEYS: Record<string, string> = {
  private: 'pages.reports.visibility.private',
  groups:  'pages.reports.visibility.groups',
  all:     'pages.reports.visibility.all',
}
export const VIS_COLORS: Record<string, { bg: string; fg: string }> = {
  all:     { bg: palette.success.tint, fg: palette.success.text },
  groups:  { bg: palette.warning.tint, fg: palette.warning.strong },
  private: { bg: 'var(--color-border-light)', fg: 'var(--color-slate)' },
}

const GET_CHANNELS_SLIM = gql`query GetChannelsSlim { notificationChannels { id name platform } }`
const GET_TEAMS_SLIM    = gql`query GetTeamsSlim { teams { id name } }`

// ── Styles (shared) ────────────────────────────────────────────────────────────

export const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 10px', borderRadius: 5, border: '1px solid var(--color-border-strong)', fontSize: 'var(--font-size-body)', boxSizing: 'border-box' }
export const labelStyle: React.CSSProperties = { fontSize: 'var(--font-size-body)', fontWeight: 600 as const, color: 'var(--color-slate)', textTransform: 'uppercase' as const, marginBottom: 4, display: 'block' as const }
export const btnPrimary: React.CSSProperties = { padding: '8px 18px', borderRadius: 7, border: 'none', background: 'var(--color-brand)', color: colors.white, cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 600 }
export const btnGhost: React.CSSProperties  = { padding: '8px 14px', borderRadius: 7, border: '1px solid var(--color-border)', background: colors.white, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }

// ── Parts of the hook: the run, the settings ───────────────────────────────────

/**
 * The frequency a saved schedule opens with: its preset, or «Custom» with the
 * cron in its box. A report saved with no cron opens on the default, every
 * day at 9:00.
 */
function frequencyOfCron(saved: string | null): { cron: string; preset: string; customCron: string } {
  const cron = saved ?? '0 9 * * *'
  const preset = SCHEDULE_PRESETS.some((p) => p.value === cron) ? cron : '__custom__'
  return { cron, preset, customCron: preset === '__custom__' ? cron : '' }
}

/** Running a report, and the results of its last run on screen. */
function useReportRun() {
  const { i18n } = useTranslation()
  // V-20: le etichette dei valori seguono la lingua di chi legge il report
  const language = i18n.resolvedLanguage ?? i18n.language
  const [sectionResults, setSectionResults] = useState<Record<string, SectionResult>>({})
  const [runExecute, { loading: execLoading, error: execError }] = useLazyQuery<{ executeReport: { sections: SectionResult[] } }>(
    EXECUTE_REPORT, { fetchPolicy: 'network-only' },
  )

  /**
   * The results on screen belong to ONE run, and they come from that run's own
   * answer (tour of 23 Sep 2026). They used to be filled by an effect on the
   * query's data, and Apollo 4 hands back the SAME object for an identical
   * answer: running a report again left every section on «Click ▶ Run». Every
   * run, and every report opened, takes a new number here; an answer that
   * arrives when its number is no longer the last one is not shown.
   */
  const runRef = useRef(0)

  function clearResults() {
    runRef.current++
    setSectionResults({})
  }

  async function runReport(templateId: string) {
    clearResults()
    const run = runRef.current
    // A failed run is reported by the `execError` effect below; a run that a
    // newer one replaced is aborted by Apollo, and there is nothing to say.
    const res = await runExecute({ variables: { templateId, language } }).catch(() => null)
    if (!res || run !== runRef.current) return
    const map: Record<string, SectionResult> = {}
    for (const s of res.data?.executeReport?.sections ?? []) {
      if (s?.sectionId) map[s.sectionId] = s
    }
    setSectionResults(map)
  }

  useEffect(() => {
    if (execError) showError(execError)
  }, [execError])

  return { sectionResults, execLoading, clearResults, runReport }
}

/**
 * The settings of a report: its name, who sees it, and the schedule that sends
 * it. The form is filled in from the report as it is saved, and saved in its
 * two parts, in order.
 */
function useReportSettings({ selectedId, refetch, onSaved }: {
  /** The report the settings are saved into. */
  selectedId: string | null
  /** Reloads the list of reports. */
  refetch: () => Promise<unknown>
  /** Called once both parts are saved. */
  onSaved: () => void
}) {
  const { t } = useTranslation()
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
  const [schedulePreset,      setSchedulePreset]      = useState('0 9 * * *')
  const [customCron,          setCustomCron]          = useState('')

  /**
   * La vista si chiude quando il salvataggio è COMPLETO, non a metà (revisione
   * totale · G-23): `onCompleted` faceva `setView('detail')` subito, e il
   * salvataggio delle impostazioni è DUE mutation in fila — se la seconda
   * (pianificazione, destinatari, formato) falliva, la scheda era già chiusa
   * con nome e visibilità salvati e il resto no, con un toast d'errore su una
   * pagina che non mostrava più il form. Ora chiude `handleSaveSettings`,
   * dopo entrambe.
   *
   * The list is reloaded there too, once the schedule is saved (23 Sep 2026):
   * the list now carries the recipients and the format, and a reload sent
   * between the two mutations could answer with the old ones after the
   * schedule's own answer — the next save would have written them back.
   */
  const [updateTemplate, { loading: updating }] = useMutation(UPDATE_REPORT_TEMPLATE, {
    onError: (e) => showError(e),
  })
  const [updateReportSchedule] = useMutation(UPDATE_REPORT_SCHEDULE)

  function fillSettings(tpl: ReportTemplate) {
    setSettingsName(tpl.name)
    setSettingsDesc(tpl.description ?? '')
    setSettingsVis(tpl.visibility)
    setSettingsTeamIds(tpl.sharedWith.map(x => x.id))
    setSettingsSched(tpl.scheduleEnabled)
    // The frequency shown is the one saved: its preset, or «Custom» with the
    // cron in its box. Both were left as the previous report had them, so a
    // report scheduled every Monday opened on «Every day at 9:00».
    const frequency = frequencyOfCron(tpl.scheduleCron)
    setSettingsSchedCron(frequency.cron)
    setSchedulePreset(frequency.preset)
    setCustomCron(frequency.customCron)
    setSettingsChanId(tpl.scheduleChannelId ?? '')
    setSettingsRecipients(tpl.scheduleRecipients ?? [])
    setSettingsFormat((tpl.scheduleFormat as 'pdf' | 'excel') ?? 'pdf')
    setRecipientInput('')
  }

  const handleSaveSettings = async () => {
    if (!selectedId) return
    const effectiveCron = schedulePreset === '__custom__' ? customCron : settingsSchedCron
    // «Custom» with no cron typed saved an empty cron: a schedule that never
    // runs, shown as enabled (tour of 23 Sep 2026). Nothing is saved.
    if (settingsSched && !effectiveCron.trim()) {
      toast.error(t('toast.report.cronRequired'))
      return
    }
    let templateSaved = false
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
      templateSaved = true
      await updateReportSchedule({
        variables: {
          templateId: selectedId,
          enabled:    settingsSched,
          cron:       settingsSched ? effectiveCron : null,
          recipients: settingsSched ? settingsRecipients : [],
          format:     settingsFormat,
        },
      })
      // G-23: solo qui, quando ENTRAMBE sono passate.
      onSaved()
    } catch (err: unknown) {
      showError(err, err instanceof Error ? err.message : t('toast.report.saveFailed'))
    } finally {
      // After the schedule, never between the two (see `updateTemplate`).
      if (templateSaved) void refetch()
    }
  }

  return {
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
    updating,
    fillSettings,
    handleSaveSettings,
  }
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useCustomReports() {
  // `t` NON si rinomina: con l'alias le sue chiavi erano invisibili a
  // `scripts/check-i18n.mjs`, che ora segnala l'alias come errore.
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [view,           setView]           = useState<View>('list')
  const [selectedId,     setSelectedId]     = useState<string | null>(null)
  const [editSection,    setEditSection]    = useState<ReportSection | null>(null)
  const [showNewDialog,  setShowNewDialog]  = useState(false)
  const [menuOpenId,     setMenuOpenId]     = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // ── New template form state ────────────────────────────────────────────────
  const [newName,    setNewName]    = useState('')
  const [newDesc,    setNewDesc]    = useState('')
  const [newVis,     setNewVis]     = useState('private')
  const [newTeamIds, setNewTeamIds] = useState<string[]>([])

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
  const { sectionResults, execLoading, clearResults, runReport } = useReportRun()

  // ── Settings form state ────────────────────────────────────────────────────
  const { fillSettings, updating, handleSaveSettings, ...settingsForm } = useReportSettings({
    selectedId, refetch, onSaved: () => setView('detail'),
  })

  const templates: ReportTemplate[]           = data?.reportTemplates ?? []
  const channels: Channel[]                   = channelsData?.notificationChannels?.filter((c: Channel) => c.platform === 'slack') ?? []
  const teams: { id: string; name: string }[] = teamsData?.teams ?? []
  const selected: ReportTemplate | null       = templates.find((tpl: ReportTemplate) => tpl.id === selectedId) ?? null

  // ── Mutations ──────────────────────────────────────────────────────────────
  const [createTemplate, { loading: creating }] = useMutation(CREATE_REPORT_TEMPLATE, {
    onError: (e) => showError(e),
  })

  const [deleteTemplate] = useMutation(DELETE_REPORT_TEMPLATE, {
    onCompleted: () => { refetch(); setSelectedId(null); setView('list') },
    onError: (e) => showError(e),
  })

  const [duplicateTemplateMutation] = useMutation<{ duplicateReportTemplate: { id: string; name: string; sections: { id: string }[] } }>(DUPLICATE_REPORT_TEMPLATE, {
    onError: (e) => showError(e),
  })

  const [addSection]    = useMutation(ADD_REPORT_SECTION,    { onCompleted: () => { refetch(); setView('detail') }, onError: (e) => showError(e) })
  const [updateSection] = useMutation(UPDATE_REPORT_SECTION, { onCompleted: () => { refetch(); setView('detail'); setEditSection(null) }, onError: (e) => showError(e) })
  const [removeSection] = useMutation(REMOVE_REPORT_SECTION, { onCompleted: () => refetch(), onError: (e) => showError(e) })

  const [exportPDF,   { loading: exportingPDF }]   = useMutation<{ exportReportPDF: string }>(EXPORT_REPORT_PDF, {
    onError: (e: { message: string }) => showError(e),
  })
  const [exportExcel, { loading: exportingExcel }] = useMutation<{ exportReportExcel: string }>(EXPORT_REPORT_EXCEL, {
    onError: (e: { message: string }) => showError(e),
  })

  /**
   * La mutation genera il file e restituisce il suo percorso `/api/reports/…`:
   * si scarica con il token. Un link nudo non lo porta, e la scheda finiva su
   * `{"error":"Unauthorized"}` (giro nel browser del 14 set 2026).
   */
  async function triggerDownload(path: string, fallbackFilename: string) {
    try {
      await downloadFile(path, fallbackFilename)
    } catch (err) {
      showError(err, t('toast.report.downloadFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  // Apollo 4 rejects a refused export AFTER calling `onError`, which has
  // already said why: without the catch the refusal was also an unhandled
  // promise rejection (tour of 23 Sep 2026).
  async function handleExportPDF() {
    if (!selectedId) return
    const res = await exportPDF({ variables: { templateId: selectedId } }).catch(() => null)
    if (res?.data?.exportReportPDF) await triggerDownload(res.data.exportReportPDF, 'report.pdf')
  }

  async function handleExportExcel() {
    if (!selectedId) return
    const res = await exportExcel({ variables: { templateId: selectedId } }).catch(() => null)
    if (res?.data?.exportReportExcel) await triggerDownload(res.data.exportReportExcel, 'report.xlsx')
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function resetNew() { setNewName(''); setNewDesc(''); setNewVis('private'); setNewTeamIds([]) }

  function openSettings(tpl: ReportTemplate) {
    // The settings are of THIS report, also when opened from a card's menu in
    // the list (tour of 23 Sep 2026): the report was not selected, so the page
    // went blank, or showed and saved into the report opened before.
    if (tpl.id !== selectedId) {
      setSelectedId(tpl.id)
      clearResults()
    }
    fillSettings(tpl)
    setMenuOpenId(null)
    setView('settings')
  }

  function goToDetail(tpl: ReportTemplate) {
    setSelectedId(tpl.id)
    clearResults()
    setView('detail')
    setMenuOpenId(null)
  }

  /**
   * F-07: server-side clone (template + sections + nodes + edges, one
   * transaction). The old client-side version created an EMPTY template.
   */
  async function duplicateTemplate(tpl: ReportTemplate) {
    setMenuOpenId(null)
    const res = await duplicateTemplateMutation({ variables: { id: tpl.id } }).catch(() => null)
    const copy = res?.data?.duplicateReportTemplate
    if (!copy) return  // errore già notificato da onError
    toast.success(t('toast.report.duplicated', { name: copy.name, count: copy.sections.length }))
    reloadQueries(refetch)
  }

  function sectionToInput(s: ReportSection): ReportSectionInput {
    return {
      title: s.title, chartType: s.chartType,
      groupByNodeId: s.groupByNodeId, groupByField: s.groupByField, groupByGranularity: s.groupByGranularity,
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
    // editSection viene azzerato in onCompleted: su errore l'editor resta aperto.
    updateSection({ variables: { sectionId: editSection.id, input } })
  }

  async function handleCreateTemplate() {
    const result = await createTemplate({ variables: { input: { name: newName, description: newDesc || null, visibility: newVis, sharedWithTeamIds: newVis === 'groups' ? newTeamIds : [] } } }).catch(() => null)
    const id = (result?.data as { createReportTemplate: { id: string } } | undefined)?.createReportTemplate?.id
    if (!id) {
      // Mutation fallita (toast già mostrato da onError): il dialog resta
      // aperto e il form non viene resettato — niente falso successo.
      return
    }
    // The report exists: a list that cannot be reloaded must not keep the dialog
    // open — a second click made a duplicate (tour of 23 Sep 2026).
    await refetch().catch((e: unknown) => { showError(e) })
    setSelectedId(id); setView('detail')
    setShowNewDialog(false); resetNew()
  }

  function handleDeleteTemplate(id: string) {
    setMenuOpenId(null)
    void confirm({ title: t('pages.reports.deleteReportTitle'), danger: true }).then((ok) => { if (ok) void deleteTemplate({ variables: { id } }) })
  }

  function handleRemoveSection(templateId: string, sectionId: string) {
    void confirm({ title: t('pages.reports.removeSectionTitle'), danger: true }).then((ok) => { if (ok) void removeSection({ variables: { templateId, sectionId } }) })
  }

  function handleExecuteAndGoToDetail(tpl: ReportTemplate) {
    goToDetail(tpl)
    void runReport(tpl.id)
  }

  function handleExecuteSelected() {
    if (!selected) return
    void runReport(selected.id)
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
    t,
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
    // Settings state (see `useReportSettings`)
    ...settingsForm,
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
