import { useId, useState } from 'react'
import { TicketOLACard } from '@/components/ticket/ola/TicketOLACard'
import { CustomFieldsCard } from '@/components/ticket/customFields/CustomFieldsCard'
import type { CustomFieldValueView } from '@/components/ticket/customFields/customFields'
import { useMe } from '@/hooks/useMe'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/hooks/useConfirm'
import { useItilTypeLabels } from '@/hooks/useItilTypeLabels'
import { FileDown, Loader2, Sparkles, Network } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { useQuery, useMutation, useLazyQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/QueryError'
import { Modal } from '@/components/Modal'
import { SectionCard } from '@/components/ui/SectionCard'
import { SeverityBadge } from '@/components/SeverityBadge'

import { GET_INCIDENT, GET_USERS, GET_TEAMS, GET_ALL_CIS } from '@/graphql/queries'
import { useTicketCIExclusions } from '@/hooks/useTicketCIExclusions'
import { EXECUTE_WORKFLOW_TRANSITION, ASSIGN_INCIDENT_TO_TEAM, ASSIGN_INCIDENT_TO_USER, ADD_INCIDENT_COMMENT, ADD_AFFECTED_CI, REMOVE_AFFECTED_CI, SET_INCIDENT_MAJOR, UPDATE_INCIDENT, LINK_RELATED_TICKET, UNLINK_RELATED_TICKET, LINK_INCIDENT_TO_PROBLEM, UNLINK_INCIDENT_FROM_PROBLEM, LINK_RESOLVED_TICKET, UNLINK_RESOLVED_TICKET } from '@/graphql/mutations'
import { UnifiedLinkedTickets, type LinkedTicketItem } from '@/components/UnifiedLinkedTickets'
import { Input, FieldLabel } from '@/components/ui/FormControls'
import { derivePriority, priorityCode } from '@/lib/priority'
import { usePriorityMatrix } from '@/hooks/usePriorityMatrix'
import { Pencil } from 'lucide-react'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { IncidentHeader } from './IncidentHeader'
import { WorkflowTimeline } from '@/components/ticket/WorkflowTimeline'
import { AffectedCIList } from '@/components/ticket/AffectedCIList'
import { CommentsSection } from '@/components/ticket/CommentsSection'
import { WatcherBar } from '@/components/WatcherBar'
import { SlaBadge, type SlaStatusInfo } from '@/components/SlaBadge'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { TicketTasksSection } from '@/components/ticket/TicketTasksSection'
import { InternalChatPanel } from '@/components/InternalChatPanel'
import { keycloak } from '@/lib/keycloak'
import { downloadPdf } from '@/lib/downloadPdf'
import { Button } from '@/components/Button'
import { DetailField } from '@/components/ui/DetailField'
import { Select, Textarea } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { formatDate, timeAgo } from './IncidentCard'
import { SimilarIncidentsPanel } from '@/components/SimilarIncidentsPanel'
import { MonitoringAlarmsSection } from '@/pages/events/CorrelatedEventsSection'
import { ImpactedServicesSection } from './ImpactedServicesSection'
import type { EventRow } from '@/types/events'
import type { ImpactedServiceRef } from '@/types/services'
import { colors } from '@/lib/tokens'
import { useSlaSettling } from '@/hooks/useSlaSettling'
import { transitionErrorText, type TransitionFailure } from '@/lib/transitionError'
import { withLocalizedLabel } from '@/lib/localizedLabel'
import { useAIFeature } from '@/hooks/useAIFeature'
import { useAIDisabledText } from '@/components/ai/AIDisabledNotice'
import { showError } from '@/lib/showError'
import { useCILabels } from '@/hooks/useCILabels'
import { ciPath } from '@/lib/ciPath'

const RESOLUTION_DRAFT = gql`
  query ResolutionDraft($incidentId: ID!) {
    resolutionDraft(incidentId: $incidentId) { draft }
  }
`
const CREATE_KB_DRAFT = gql`
  mutation CreateKbDraftFromIncident($incidentId: ID!) {
    createKbDraftFromIncident(incidentId: $incidentId) { id slug title }
  }
`

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkflowInstance {
  id:          string
  currentStep: string
  status:      string
}

interface WorkflowTransition {
  toStep:        string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
}

interface WorkflowStepExecution {
  id:          string
  stepName:    string
  enteredAt:   string
  exitedAt:    string | null
  durationMs:  number | null
  triggeredBy: string
  triggerType: string
  notes:       string | null
}

interface CIRef {
  id:          string
  name:        string
  type:        string
  status:      string
  environment: string
}

interface ImpactPathNode { id: string; name: string; type: string | null }
interface ImpactedApp { distance: number; via: string | null; ci: CIRef; path: ImpactPathNode[] }

interface Team { id: string; name: string }

interface Incident {
  customFields:         CustomFieldValueView[]
  id:                   string
  number:               string
  title:                string
  description:          string | null
  severity:             string
  impact:               string | null
  urgency:              string | null
  priority:             string
  major:                boolean
  status:               string
  rootCause:            string | null
  createdAt:            string
  updatedAt:            string
  resolvedAt:           string | null
  assignee:             { id: string; name: string; email: string } | null
  assignedTeam:         Team | null
  affectedCIs:          CIRef[]
  linkedIncidents?:     LinkedTicketItem[]
  linkedProblems?:      LinkedTicketItem[]
  linkedChanges?:       LinkedTicketItem[]
  impactedApplications: ImpactedApp[]
  workflowInstance:     WorkflowInstance | null
  availableTransitions: WorkflowTransition[]
  workflowHistory:      WorkflowStepExecution[]
  comments:             Comment[]
  slaStatus:            SlaStatusInfo | null
  /** Allarmi di monitoraggio correlati (Event Management, ondata 3). */
  correlatedEvents:     EventRow[]
  /** Quanti sono in TUTTO: `correlatedEvents` e paginato (revisione totale · G-EVT-11). */
  correlatedEventCount: number
  correlatedEventsPurged: number
  /** Servizi monitorati collegati all'incident (Servizi monitorati, ondata 3). */
  impactedServices:     ImpactedServiceRef[]
}

interface Comment {
  id:        string
  text:      string
  isInternal: boolean
  createdAt: string
  updatedAt: string
  author:    { id: string; name: string; email: string } | null
}

interface User { id: string; name: string; email: string; teams: { id: string; name: string }[] }

// ── Main component ────────────────────────────────────────────────────────────

export function IncidentDetailPage() {
  const { matrix } = usePriorityMatrix()
  const { t }    = useTranslation()
  const confirm  = useConfirm()
  const { labelOf: typeLabel } = useItilTypeLabels()
  const ciLabels = useCILabels()
  const editIds  = { title: useId(), description: useId(), impact: useId(), urgency: useId(), team: useId(), user: useId() }
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [pendingTransition,      setPendingTransition]      = useState<WorkflowTransition | null>(null)
  const [transitionNotes,        setTransitionNotes]        = useState('')
  const [notesError,             setNotesError]             = useState('')
  const [isTransitionDialogOpen, setIsTransitionDialogOpen] = useState(false)

  const [selectedTeamId,     setSelectedTeamId]     = useState('')
  const [selectedUserId,     setSelectedUserId]      = useState('')
  const [showReassign,       setShowReassign]        = useState(false)
  const [awaitingUserAssign, setAwaitingUserAssign]  = useState(false)

  const [exportingPdf, setExportingPdf] = useState(false)
  // Funzioni AI spente dall'organizzazione (ondata 6): i bottoni restano, spenti e con il perché.
  const postIncidentOn = useAIFeature('postIncident')
  const kbArticlesOn = useAIFeature('kbArticles')
  const postIncidentOffText = useAIDisabledText('postIncident')
  const kbArticlesOffText = useAIDisabledText('kbArticles')
  const [genResolutionDraft, { loading: draftLoading }] = useLazyQuery<{ resolutionDraft: { draft: string } }>(RESOLUTION_DRAFT, { fetchPolicy: 'network-only' })
  const [createKbDraft, { loading: kbDraftLoading }] = useMutation<{ createKbDraftFromIncident: { id: string; slug: string; title: string } }>(CREATE_KB_DRAFT, {
    // La bozza nasce in pochi secondi di generazione: il messaggio resta abbastanza
    // da essere letto e porta dove la bozza si completa (prima spariva e basta).
    onCompleted: (d) => toast.success(t('toast.incident.kbDraftCreated', { title: d.createKbDraftFromIncident.title }), {
      duration: 12_000,
      action: { label: t('toast.incident.kbDraftOpen'), onClick: () => navigate('/admin/knowledge-base') },
    }),
    onError: (err) => showError(err, t('toast.incident.kbDraftFailed', { error: err.message })),
  })

  const [ciSearch,      setCiSearch]      = useState('')
  const [timelineOpen, setTimelineOpen] = useState(true)

  const { can } = useMe()
  // Chi legge e basta non modifica: la stessa regola dell'API (viewer).
  // Il permesso, non il NOME del ruolo (revisione totale · F-2): dall'ondata
  // «Nulla cablato» i ruoli sono del cliente, e l'API concede
  // `setTicketCustomFields` a `ticket.work`. Col confronto sul nome un ruolo
  // «tecnico L2» con quel permesso vedeva i campi in sola lettura, e un ruolo
  // chiamato «operator» SENZA il permesso vedeva il form e prendeva un 403.
  const canEditCustomFields = can('ticket.work')
  const { data, loading, error, refetch, startPolling, stopPolling } = useQuery<{ incident: Incident | null }>(
    GET_INCIDENT,
    { variables: { id }, skip: !id },
  )
  // ── Ticket collegati (incident / problem / change): la ricerca vive in
  //    UnifiedLinkedTickets (query lazy per tab) ────────────────────────────
  const linkOpts = { onError: (e: { message: string }) => showError(e), onCompleted: () => { void refetch() } }
  const [linkRelated]    = useMutation(LINK_RELATED_TICKET, linkOpts)
  const [unlinkRelated]  = useMutation(UNLINK_RELATED_TICKET, linkOpts)
  const [linkIncProblem] = useMutation(LINK_INCIDENT_TO_PROBLEM, linkOpts)
  const [unlinkIncProblem] = useMutation(UNLINK_INCIDENT_FROM_PROBLEM, linkOpts)
  const [linkResolved]   = useMutation(LINK_RESOLVED_TICKET, linkOpts)
  const [unlinkResolved] = useMutation(UNLINK_RESOLVED_TICKET, linkOpts)

  const { data: usersData } = useQuery<{ users: User[] }>(GET_USERS)
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS)
  // CM-8: i tipi di CI esclusi per questo tipo di ticket non si propongono (l'API li rifiuta comunque).
  const { excluded: excludedCITypes } = useTicketCIExclusions('incident')

  const { data: ciSearchData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20, excludeCiTypes: excludedCITypes },
    skip: ciSearch.length < 2 || excludedCITypes === undefined,
  })

  const [execTransition, { loading: transitioning }] = useMutation<{
    executeWorkflowTransition: TransitionFailure & { success: boolean; instance: { currentStep: string } }
  }>(EXECUTE_WORKFLOW_TRANSITION, {
    onCompleted: (res) => {
      const r = res.executeWorkflowTransition
      if (r.success) {
        toast.success(t('toast.incident.transitionCompletedTo', { step: incidentStepLabel(r.instance.currentStep) }))
        setIsTransitionDialogOpen(false)
        setPendingTransition(null)
        setTransitionNotes('')
        void refetch()
      } else {
        toast.error(transitionErrorText(r, t('toast.incident.transitionFailed')))
      }
    },
    onError: (err) => showError(err),
  })

  const [setMajor, { loading: settingMajor }] = useMutation(SET_INCIDENT_MAJOR, {
    refetchQueries: ['GetIncident'],
    onCompleted: () => toast.success(t('toast.incident.majorUpdated')),
    onError: (e) => showError(e),
  })

  const [editOpen, setEditOpen] = useState(false)
  const [pathModal, setPathModal] = useState<ImpactedApp | null>(null)
  /**
   * Nessun valore cablato per impatto e urgenza (revisione totale · F-30):
   * `medium` era scritto qui, e su un'organizzazione con impatti `1..4` il
   * form partiva da un valore fuori vocabolario — la tendina si vedeva vuota
   * e il salvataggio mandava comunque `medium`. Il valore iniziale è quello
   * dell'incident; se non l'ha, il primo della matrice del cliente.
   */
  const [editForm, setEditForm] = useState({ title: '', description: '', impact: '', urgency: '' })
  const [updateIncident, { loading: savingEdit }] = useMutation(UPDATE_INCIDENT, {
    onCompleted: () => { setEditOpen(false); toast.success(t('toast.incident.updated')) },
    onError: (e) => showError(e),
    refetchQueries: ['GetIncident'],
  })

  const [assignToTeam, { loading: assigningTeam }] = useMutation(ASSIGN_INCIDENT_TO_TEAM, {
    onCompleted: (_data, opts) => {
      toast.success(t('toast.incident.teamAssigned'))
      setSelectedTeamId('')
      setShowReassign(false)
      setSelectedUserId('')
      const incidentId = (opts?.variables as { id?: string } | undefined)?.id
      if (incidentId) {
        void assignToUser({ variables: { id: incidentId, userId: null } })
          .then(() => { setAwaitingUserAssign(true); void refetch() })
          // Un un-assign fallito NON è "in attesa di utente": va detto.
          .catch((e: { message?: string }) => { showError(e, e.message ?? t('toast.incident.unassignFailed')); void refetch() })
      } else {
        setAwaitingUserAssign(true)
        void refetch()
      }
    },
    onError: (err) => showError(err),
  })

  const [assignToUser, { loading: assigningUser }] = useMutation(ASSIGN_INCIDENT_TO_USER, {
    onCompleted: (_data, opts) => {
      const userId = (opts?.variables as { userId?: string | null } | undefined)?.userId
      if (userId) {
        // «Preso in carico» era vero solo per chi assegnava a sé stesso.
        const name = users.find((u) => u.id === userId)?.name ?? ''
        toast.success(t('toast.incident.assignedToUser', { name }))
        setAwaitingUserAssign(false)
        setSelectedUserId('')
        void refetch()
      }
    },
    onError: (err) => showError(err),
  })

  const [addComment, { loading: addingComment }] = useMutation(ADD_INCIDENT_COMMENT, {
    onCompleted: () => {
      toast.success(t('toast.incident.commentAdded'))
      void refetch()
    },
    onError: (err) => showError(err),
  })

  const [addCI] = useMutation(ADD_AFFECTED_CI, {
    onCompleted: () => { toast.success(t('toast.incident.ciAdded')); setCiSearch(''); void refetch() },
    onError: (err) => showError(err),
  })

  const [removeCI] = useMutation(REMOVE_AFFECTED_CI, {
    onCompleted: () => { toast.success(t('toast.incident.ciRemoved')); void refetch() },
    onError: (err) => showError(err),
  })

  const incident  = data?.incident
  useSlaSettling(incident?.slaStatus, !!incident?.resolvedAt, { startPolling, stopPolling })
  const users     = usersData?.users ?? []
  const teams     = teamsData?.teams ?? []
  const ciResults = ciSearchData?.allCIs?.items ?? []
  const { byName: incidentStepByName, error: workflowStepsError, isTerminal: incidentStepIsTerminal, categoryOf: incidentStepCategory, labelFor: incidentStepLabel } = useWorkflowSteps('incident')
  const { labelOf } = useDomainVocabularies()

  function handleTransitionClick(tr: WorkflowTransition) {
    // Guard rails come from the workflow definition: if it failed to load we
    // cannot evaluate the gates, so refuse to proceed instead of skipping them.
    if (workflowStepsError) {
      showError(workflowStepsError, t('toast.incident.workflowRulesNotLoaded', { error: workflowStepsError.message }))
      return
    }
    // Assignment gates are no longer hardcoded per step name. If the target
    // of this transition is a non-terminal step whose category is 'active',
    // a team must be assigned — and if the user is moving past the first
    // non-initial step, an assignee is required too. The workflow itself
    // decides which steps these are via the `category` metadata.
    const targetMeta = incidentStepByName.get(tr.toStep)
    const currentMeta = incidentStepByName.get(incident?.status ?? '')
    if (targetMeta?.category === 'active' && currentMeta?.isInitial && !incident?.assignedTeam) {
      toast.error(t('toast.incident.selectTeamFirst'))
      return
    }
    if (targetMeta?.category === 'active' && !currentMeta?.isInitial && !incident?.assignee && incident?.assignedTeam) {
      toast.error(t('toast.incident.selectUserFirst'))
      return
    }
    if (tr.requiresInput) {
      setPendingTransition(tr)
      setTransitionNotes('')
      setNotesError('')
      setIsTransitionDialogOpen(true)
    } else {
      if (!incident?.workflowInstance) return
      void execTransition({
        variables: {
          instanceId: incident.workflowInstance.id,
          toStep:     tr.toStep,
        },
      })
    }
  }

  async function handleExportPdf() {
    if (!incident) return
    setExportingPdf(true)
    try {
      await downloadPdf(`/api/incidents/${incident.id}/pdf`, `${incident.number || incident.id}.pdf`)
    } catch {
      toast.error(t('detail.exportPdfFailed'))
    } finally {
      setExportingPdf(false)
    }
  }

  // Solo al primo caricamento: un refetch (dopo un commento) rimetteva lo scheletro,
  // la pagina si rimontava richiudendo le sezioni e tornava in cima (giro del 14 set 2026, #20).
  if (loading && !data) {
    return (
      <div className="space-y-4" style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
        <Skeleton style={{ height: 32, width: 200 }} />
        <Skeleton style={{ height: 60 }} />
        <Skeleton style={{ height: 40, width: 320 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>
          <div className="space-y-4">
            <Skeleton style={{ height: 120 }} />
            <Skeleton style={{ height: 160 }} />
          </div>
          <div className="space-y-4">
            <Skeleton style={{ height: 200 }} />
            <Skeleton style={{ height: 240 }} />
          </div>
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <PageContainer>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </PageContainer>
    )
  }

  if (!incident) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 'var(--font-size-body)' }}>
        {t('pages.incidents.notFound')}{' '}
        <button
          type="button"
          onClick={() => navigate('/incidents')}
          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}
        >
          {t('detail.backToList')}
        </button>
      </div>
    )
  }

  const manualTransitions = incident.availableTransitions.filter((t) => t.toStep !== undefined).map(withLocalizedLabel)
  const historyDesc       = [...incident.workflowHistory].reverse()

  return (
    <PageContainer>

      {incident.major && (
        <div role="alert" style={{ background: 'var(--color-danger)', color: colors.white, padding: '10px 16px', borderRadius: 8, marginBottom: 12, fontWeight: 700, letterSpacing: '0.03em', display: 'flex', alignItems: 'center', gap: 8 }}>
          {t('pages.incidentDetail.major')}
        </div>
      )}

      {/* Header + action buttons */}
      <IncidentHeader
        incident={incident}
        manualTransitions={manualTransitions}
        transitioning={transitioning}
        onBack={() => navigate(-1)}
        onTransitionClick={handleTransitionClick}
        onRequestChange={() => navigate(`/changes/new?incidentId=${incident.id}`)}
      />

      {/* Watchers bar + PDF export */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Button
          variant="secondary"
          icon={<Pencil size={13} />}
          onClick={() => {
            setEditForm({
              title: incident.title, description: incident.description ?? '',
              // F-30: il primo valore della matrice del cliente, non «medium».
              impact:  incident.impact  ?? matrix?.impacts[0]   ?? '',
              urgency: incident.urgency ?? matrix?.urgencies[0] ?? '',
            })
            setEditOpen(true)
          }}
        >
          {t('common.edit')}
        </Button>
        <Button
          variant="secondary"
          disabled={settingMajor}
          onClick={() => void (async () => {
            // Giro nel browser del 14 set 2026 (#21): dichiarare un Major
            // Incident avvisa il Change Manager e le regole di escalation;
            // partiva al primo clic, senza conferma.
            const ok = await confirm(incident.major
              ? { title: t('pages.incidentDetail.revokeMajorConfirmTitle'), body: t('pages.incidentDetail.revokeMajorConfirmBody', { number: incident.number }), confirmLabel: t('pages.incidentDetail.revokeMajor') }
              : { title: t('pages.incidentDetail.declareMajorConfirmTitle'), body: t('pages.incidentDetail.declareMajorConfirmBody', { number: incident.number }), confirmLabel: t('pages.incidentDetail.declareMajor'), danger: true })
            if (ok) await setMajor({ variables: { id: incident.id, major: !incident.major } })
          })()}
          style={incident.major ? { color: 'var(--color-danger)', borderColor: 'var(--color-danger)' } : undefined}
        >
          {t(incident.major ? 'pages.incidentDetail.revokeMajor' : 'pages.incidentDetail.declareMajor')}
        </Button>
        {/*
          La bozza KB si offre sui ticket CHIUSI o RISOLTI, riconosciuti dai
          metadata del passo e non dai due nomi di fabbrica (B-22): con un
          passo di risoluzione rinominato il bottone non compariva mai.
        */}
        {(incidentStepIsTerminal(incident.status) || incidentStepCategory(incident.status) === 'resolved') && (
          <Button
            variant="secondary"
            disabled={kbDraftLoading || kbArticlesOn !== true}
            title={kbArticlesOn === false ? kbArticlesOffText : undefined}
            icon={kbDraftLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            onClick={() => void createKbDraft({ variables: { incidentId: incident.id } })}
          >
            {t('pages.incidentDetail.kbDraft')}
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={exportingPdf}
          icon={exportingPdf ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
          onClick={() => void handleExportPdf()}
        >
          {t('detail.exportPdf')}
        </Button>
        <WatcherBar entityType="incident" entityId={incident.id} />
      </div>

      {/* Edit fields modal (status resta guidato dal workflow) */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={t('pages.incidentDetail.editTitle')}
        as="form"
        onSubmit={(e) => {
          e.preventDefault()
          void updateIncident({ variables: { id: incident.id, input: {
            title: editForm.title.trim(),
            description: editForm.description.trim() || null,
            impact: editForm.impact,
            urgency: editForm.urgency,
          } } })
        }}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={savingEdit || editForm.title.trim().length === 0}>{savingEdit ? t('common.saving') : t('common.save')}</Button>
          </>
        }
      >
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={editIds.title}>{t('pages.serviceRequestDetail.titleRequired')}</FieldLabel>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: primo campo del modal di modifica aperto dall'utente */}
          <Input id={editIds.title} value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required autoFocus />
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel htmlFor={editIds.description}>{t('common.description')}</FieldLabel>
          <Textarea id={editIds.description} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={4} />
        </div>
        <div className="og-pair" style={{ alignItems: 'end' }}>
          <div>
            <FieldLabel htmlFor={editIds.impact}>{t('detail.impact')}</FieldLabel>
            <Select id={editIds.impact} value={editForm.impact} onChange={(e) => setEditForm({ ...editForm, impact: e.target.value })}>
              {/* Secondo giro UI · V-18: le etichette del Dizionario, non «low / medium / high». */}
              {(matrix?.impacts ?? []).map((o) => <option key={o} value={o}>{labelOf('impact', o) ?? o}</option>)}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor={editIds.urgency}>{t('detail.urgency')}</FieldLabel>
            <Select id={editIds.urgency} value={editForm.urgency} onChange={(e) => setEditForm({ ...editForm, urgency: e.target.value })}>
              {(matrix?.urgencies ?? []).map((o) => <option key={o} value={o}>{labelOf('urgency', o) ?? o}</option>)}
            </Select>
          </div>
        </div>
        <p style={{ marginTop: 10, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
          {/* Dalla matrice del cliente, non da una copia nel web (revisione ·
              C·N-3): una coppia che la matrice non copre lo dice, invece di
              mostrare una priorità che il server poi rifiuta. */}
          {t('pages.incidentDetail.derivedPriority')} <strong>{
            (() => {
              const p = derivePriority(matrix, editForm.impact, editForm.urgency)
              return p === null
                ? t('pages.domainMatrices.notCovered')
                : `${priorityCode(matrix?.priorities ?? [], p)} — ${labelOf('priority', p) ?? p}`
            })()
          }</strong>
        </p>
      </Modal>

      {/* Body grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left column */}
        <div>

          {/* Dettagli (descrizione in testa) */}
          <SectionCard title={t('detail.sections.incidentInformation')} defaultOpen>
            <div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                <DetailField label={t('detail.ticketNumber')} value={<span style={{ fontWeight: 600 }}>{incident.number}</span>} />
                <DetailField label={t('detail.sections.description')} value={
                  incident.description
                    ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>{incident.description}</p>
                    : <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: 0 }}>{t('detail.noDescription')}</p>
                } />
              </div>
              <div className="og-pair" style={{ marginBottom: 16 }}>
                  <DetailField label={t('detail.priority')} value={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><b>{priorityCode(matrix?.priorities ?? [], incident.priority)}</b><SeverityBadge value={incident.priority} vocabulary="priority" /></span>} />
                  {incident.impact && incident.urgency && (
                    <DetailField label={t('detail.impactUrgency')} value={
                      /*
                        Le ETICHETTE, non i valori: qui si leggeva «high / high».
                        E si chiedono a due vocabolari diversi di proposito —
                        `low` è «Basso» per l'impatto e «Bassa» per l'urgenza.
                      */
                      `${labelOf('impact', incident.impact) ?? incident.impact} / ${labelOf('urgency', incident.urgency) ?? incident.urgency}`
                    } />
                  )}
                  <DetailField label={t('sla.title')} value={
                    incident.slaStatus
                      ? <SlaBadge sla={incident.slaStatus} />
                      : <span style={{ color: 'var(--text-muted)' }}>{t('sla.none')}</span>
                  } />
                  <DetailField label={t('detail.workflowStep')} value={
                    <Pill bg="var(--color-brand-light)" color="var(--color-brand)" radius={100} style={{ fontSize: 'var(--font-size-body)', textTransform: 'capitalize' }}>
                      {/*
                        L'ETICHETTA del passo, come la timeline e come la
                        pagina del problem: qui si leggeva il nome interno
                        («New») mentre la timeline, venti pixel a destra,
                        diceva già «Nuovo» — sullo stesso incident.
                      */}
                      {incident.workflowInstance ? (incidentStepLabel(incident.workflowInstance.currentStep) || incident.workflowInstance.currentStep.replace(/_/g, ' ')) : 'N/D'}
                    </Pill>
                  } />
                  <DetailField label={t('detail.assignedTo')} value={
                    incident.assignee ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>{incident.assignee.name}</div>
                        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>{incident.assignee.email}</div>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>{t('detail.notAssigned')}</span>
                    )
                  } />
                  <DetailField label={t('detail.openedAt')} value={formatDate(incident.createdAt)} />
                  <DetailField label={t('detail.updatedAt')} value={timeAgo(incident.updatedAt)} />
                  {incident.resolvedAt && (
                    <DetailField label={t('detail.resolvedAt')} value={formatDate(incident.resolvedAt)} />
                  )}
                  {incident.rootCause && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <DetailField label={t('detail.rootCause')} value={incident.rootCause} />
                    </div>
                  )}
                </div>

                {/* Assegnazione a due step — nascosta quando l'incident è in
                    uno step terminale (es. closed / resolved). */}
                {!incidentStepByName.get(incident.status)?.isTerminal && (() => {
                  const hasTeam = !!incident.assignedTeam
                  const hasUser = !!incident.assignee && !awaitingUserAssign

                  if (hasTeam && hasUser && !showReassign) {
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>
                          {t('detail.team')}: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{incident.assignedTeam!.name}</span>
                        </div>
                        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>
                          {t('detail.assignedTo')}: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{incident.assignee!.name}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setShowReassign(true); setAwaitingUserAssign(false) }}
                          style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, fontSize: 'var(--font-size-body)', color: 'var(--accent)', cursor: 'pointer', textAlign: 'left' }}
                        >
                          {t('detail.reassign')}
                        </button>
                      </div>
                    )
                  }

                  if (!hasTeam || showReassign) {
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label htmlFor={editIds.team} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--text-muted)' }}>{t('detail.team')}</label>
                        <Select
                          id={editIds.team}
                          value={selectedTeamId}
                          onChange={(e) => setSelectedTeamId(e.target.value)}
                          style={{ padding: '8px 10px', border: '1px solid var(--border)', color: 'var(--text-primary)', background: 'var(--surface)' }}
                        >
                          <option value="">{t('detail.selectTeam')}</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </Select>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {showReassign && (
                            <button type="button" onClick={() => setShowReassign(false)} style={{ flex: 1, padding: '7px 0', background: 'none', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                              {t('common.cancel')}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={!selectedTeamId || !selectedTeamId.trim() || assigningTeam}
                            onClick={() => {
                              if (!selectedTeamId) return
                              void assignToTeam({ variables: { id: incident.id, teamId: selectedTeamId } })
                              setShowReassign(false)
                            }}
                            style={{ flex: 1, padding: '7px 0', backgroundColor: (!selectedTeamId || assigningTeam) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedTeamId || assigningTeam) ? 'var(--text-muted)' : colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: (!selectedTeamId || assigningTeam) ? 'not-allowed' : 'pointer' }}
                          >
                            {assigningTeam ? t('detail.assigning') : t('detail.assignTeam')}
                          </button>
                        </div>
                      </div>
                    )
                  }

                  const teamUsers = users.filter((u) => u.teams?.some((t) => t.id === incident.assignedTeam?.id))
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>
                        {t('detail.team')}: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{incident.assignedTeam!.name}</span>
                      </div>
                      <label htmlFor={editIds.user} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--text-muted)' }}>{t('detail.assignedTo')}</label>
                      <Select
                        id={editIds.user}
                        value={selectedUserId}
                        onChange={(e) => setSelectedUserId(e.target.value)}
                        style={{ padding: '8px 10px', border: '1px solid var(--border)', color: 'var(--text-primary)', background: 'var(--surface)' }}
                      >
                        <option value="">{t('detail.selectUser')}</option>
                        {teamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </Select>
                      {/* Il pulsante assegna la persona scelta: si accende solo dopo la scelta, e lo dice. */}
                      {!selectedUserId && (
                        <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                          {teamUsers.length === 0 ? t('detail.noTeamMembers') : t('detail.chooseUserToAssign')}
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={!selectedUserId || !selectedUserId.trim() || assigningUser}
                        onClick={() => {
                          if (!selectedUserId) return
                          void assignToUser({ variables: { id: incident.id, userId: selectedUserId } })
                        }}
                        style={{ padding: '7px 0', backgroundColor: (!selectedUserId || assigningUser) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedUserId || assigningUser) ? 'var(--text-muted)' : colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: (!selectedUserId || assigningUser) ? 'not-allowed' : 'pointer' }}
                      >
                        {assigningUser ? t('detail.assigning') : t('detail.assignUser')}
                      </button>
                    </div>
                  )
                })()}
            </div>
          </SectionCard>

          {/* Campi del cliente (verifica «Cosa resta cablato», ondata 4) */}
          <TicketOLACard entityType="incident" entityId={incident.id} />
          <CustomFieldsCard entityType="incident" ticketId={incident.id} fields={incident.customFields ?? []} canEdit={canEditCustomFields} onSaved={() => void refetch()} />

          {/* CI Impattati */}
          <AffectedCIList
            affectedCIs={incident.affectedCIs}
            ciResults={ciResults}
            excludedTypes={excludedCITypes ?? []}
            onSearchChange={setCiSearch}
            onAddCI={(ciId) => void addCI({ variables: { incidentId: incident.id, ciId } })}
            onRemoveCI={(ciId) => void removeCI({ variables: { incidentId: incident.id, ciId } })}
          />

          {/* Ticket collegati (sezione unica, stile change) */}
          <UnifiedLinkedTickets
            title={t('pages.changeDetail.linkedTickets')}
            excludeId={incident.id}
            types={[
              {
                kind: 'INCIDENT', label: typeLabel('incident'), routeBase: '/incidents',
                items: incident.linkedIncidents ?? [],
                onLink: (otherId) => void linkRelated({ variables: { entityType: 'incident', entityId: incident.id, otherId } }),
                onUnlink: (otherId) => void unlinkRelated({ variables: { entityType: 'incident', entityId: incident.id, otherId } }),
              },
              {
                kind: 'PROBLEM', label: typeLabel('problem'), routeBase: '/problems',
                items: incident.linkedProblems ?? [],
                onLink: (problemId) => void linkIncProblem({ variables: { problemId, incidentId: incident.id } }),
                onUnlink: (problemId) => void unlinkIncProblem({ variables: { problemId, incidentId: incident.id } }),
              },
              {
                kind: 'CHANGE', label: typeLabel('change'), routeBase: '/changes',
                items: incident.linkedChanges ?? [],
                onLink: (changeId) => void linkResolved({ variables: { changeId, entityType: 'incident', entityId: incident.id } }),
                onUnlink: (changeId) => void unlinkResolved({ variables: { changeId, entityType: 'incident', entityId: incident.id } }),
              },
            ]}
          />

          {/* Allarmi di monitoraggio correlati (aperti/agganciati dalla policy eventi) */}
          <MonitoringAlarmsSection events={incident.correlatedEvents} total={incident.correlatedEventCount} purged={incident.correlatedEventsPurged} incidentId={incident.id} />

          {/* Servizi monitorati collegati (visibile solo se ce n'è almeno uno) */}
          <ImpactedServicesSection services={incident.impactedServices} />

          {/* Applicazioni impattate (dal grafo delle dipendenze) — D·6.4: testi in i18n, non cablati in italiano */}
          <SectionCard title={t('pages.incidents.impactedApplications.title')} count={incident.impactedApplications.length} collapsible>
            {incident.impactedApplications.length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: 0 }}>
                {t('pages.incidents.impactedApplications.empty')}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {incident.impactedApplications.map((a) => (
                  <div key={a.ci.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <Link to={ciPath(a.ci)} style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}>
                        {a.ci.name}
                      </Link>
                      <div style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)', marginTop: 2 }}>
                        {a.distance === 0
                          ? t('pages.incidents.impactedApplications.directly')
                          : t('pages.incidents.impactedApplications.via', { via: a.via ?? '—', count: a.distance })}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                      {a.ci.environment && <Pill bg="var(--surface-2)" color="var(--text-muted)" radius={100} style={{ fontSize: 'var(--font-size-caption)' }}>{ciLabels.environmentLabel(a.ci.environment)}</Pill>}
                      {/* L'etichetta del Dizionario, non il valore grezzo (revisione
                          totale · F-33): con un `ci_status` in italiano la card dei CI
                          colpiti mostrava ancora «in_service». */}
                      {a.ci.status && <Pill bg="var(--color-brand-light)" color="var(--color-brand)" radius={100} style={{ fontSize: 'var(--font-size-caption)' }}>{ciLabels.statusLabel(a.ci.status)}</Pill>}
                      <button
                        type="button"
                        onClick={() => setPathModal(a)}
                        title={t('pages.incidents.impactedApplications.pathButtonHint')}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-1)', color: 'var(--accent)', fontSize: 'var(--font-size-caption)', fontWeight: 500, cursor: 'pointer' }}
                      >
                        <Network size={13} /> {t('pages.incidents.impactedApplications.pathButton')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* Allegati */}
          <TicketTasksSection entityId={incident.id} />
          <AttachmentsSection entityType="incident" entityId={incident.id} defaultOpen={false} />

          {/* Commenti */}
          <CommentsSection
            comments={incident.comments}
            adding={addingComment}
            onChanged={() => void refetch()}
            onAdd={(text, isInternal) => addComment({ variables: { id: incident.id, text, isInternal } })}
          />

          {/* Internal Chat (agents only) */}
          <InternalChatPanel
            entityType="incident"
            entityId={incident.id}
            currentUserId={keycloak.subject ?? ''}
          />
        </div>

        {/* Right column */}
        <div>
          <WorkflowTimeline
            entityType="incident"
            historyDesc={historyDesc}
            timelineOpen={timelineOpen}
            onToggle={() => setTimelineOpen((p) => !p)}
          />
          <div style={{ marginTop: 16 }}>
            <SimilarIncidentsPanel incidentId={incident.id} />
          </div>
        </div>
      </div>

      {/* Transition Dialog */}
      <Modal
        open={isTransitionDialogOpen && !!pendingTransition}
        onClose={() => { setIsTransitionDialogOpen(false); setTransitionNotes(''); setNotesError('') }}
        title={
          pendingTransition?.inputField === 'rootCause'
            ? t('pages.incidents.rootCauseAnalysis')
            : t('pages.incidents.transitionTo', { step: incidentStepLabel(pendingTransition?.toStep ?? '') })
        }
        width={480}
        footer={
          <>
            <button
              type="button"
              onClick={() => { setIsTransitionDialogOpen(false); setTransitionNotes(''); setNotesError('') }}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500 }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={transitioning || transitionNotes.trim().length < 10}
              onClick={() => {
                if (transitionNotes.trim().length < 10) { setNotesError(t('forms.minChars', { count: 10 })); return }
                if (!incident?.workflowInstance?.id) { toast.error(t('toast.incident.workflowInstanceMissing')); return }
                if (!pendingTransition?.toStep) { toast.error(t('toast.incident.transitionNotSelected')); return }
                void execTransition({
                  variables: {
                    instanceId: incident.workflowInstance.id,
                    toStep: pendingTransition.toStep,
                    notes: transitionNotes.trim(),
                  },
                  onCompleted: (data) => {
                    if (data.executeWorkflowTransition.success) {
                      toast.success(t('toast.incident.transitionExecuted'))
                      setIsTransitionDialogOpen(false)
                      setPendingTransition(null)
                      setTransitionNotes('')
                      void refetch()
                    } else {
                      toast.error(transitionErrorText(data.executeWorkflowTransition, t('toast.incident.transitionError')))
                    }
                  },
                  onError: (err) => showError(err),
                })
              }}
              style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500, backgroundColor: transitionNotes.trim().length >= 10 ? 'var(--accent)' : 'var(--surface-2)', color: transitionNotes.trim().length >= 10 ? colors.white : 'var(--text-muted)' }}
            >
              {transitioning ? t('pages.incidentDetail.running') : t('common.confirm')}
            </button>
          </>
        }
      >
        {pendingTransition && (
          <>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', marginBottom: 16, marginTop: 0 }}>
              {pendingTransition.inputField === 'rootCause'
                ? t('pages.incidentDetail.rootCauseHint')
                : t('pages.incidentDetail.transitionNoteHint')}
            </p>
            <button
              type="button"
              disabled={draftLoading || postIncidentOn !== true}
              title={postIncidentOn === false ? postIncidentOffText : undefined}
              onClick={() => {
                void genResolutionDraft({ variables: { incidentId: incident.id } }).then((res) => {
                  if (res.error) showError(res.error, t('toast.incident.aiDraftFailed', { error: res.error.message }))
                  else if (res.data) setTransitionNotes(res.data.resolutionDraft.draft)
                  else toast.error(t('toast.incident.aiDraftNoResponse'))
                })
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 8, padding: '5px 12px', borderRadius: 7, border: '1px solid var(--color-brand)', background: 'transparent', color: 'var(--color-brand)', fontSize: 'var(--font-size-label)', fontWeight: 500, cursor: draftLoading ? 'wait' : 'pointer' }}
            >
              <Sparkles size={12} /> {draftLoading ? t('pages.incidentDetail.aiDraftRunning') : t('pages.incidentDetail.aiDraft')}
            </button>
            <Textarea
              value={transitionNotes}
              onChange={(e) => { setTransitionNotes(e.target.value); setNotesError('') }}
              placeholder={t(pendingTransition.inputField === 'rootCause' ? 'pages.incidentDetail.rootCausePlaceholder' : 'pages.problemDetail.transitionNotes')}
              rows={4}
              style={{ resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: textarea del dialogo di transizione aperto dall'utente
              autoFocus
            />
            {notesError && (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)', margin: '6px 0 0 0' }}>{notesError}</p>
            )}
          </>
        )}
      </Modal>

      {/* Percorso d'impatto: dal CI colpito → … → applicazione */}
      <Modal
        open={!!pathModal}
        onClose={() => setPathModal(null)}
        title={pathModal
          ? t('pages.incidents.impactedApplications.pathTitle', { name: pathModal.ci.name })
          : t('pages.incidents.impactedApplications.pathTitleNoApp')}
        width={640}
      >
        {pathModal && (
          <div>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: '0 0 16px 0' }}>
              {pathModal.distance > 0
                ? t('pages.incidents.impactedApplications.pathIntro', { count: pathModal.distance })
                : t('pages.incidents.impactedApplications.pathIntroDirect')}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, overflowX: 'auto', padding: '4px 0' }}>
              {pathModal.path.map((n, idx) => {
                const isRoot = idx === 0
                const isApp  = idx === pathModal.path.length - 1
                const border = isApp ? 'var(--accent)' : isRoot ? 'var(--color-trigger-sla-breach)' : 'var(--border)'
                const label  = isApp
                  ? t('pages.incidents.impactedApplications.pathNodeApplication')
                  : isRoot
                    ? t('pages.incidents.impactedApplications.pathNodeRoot')
                    : (n.type ?? t('pages.incidents.impactedApplications.pathNodeFallback'))
                return (
                  <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Link
                      // F-32: senza tipo si passa dalla rotta che lo risolve dal
                      // grafo, invece di ripiegare in silenzio su «application».
                      to={ciPath(n)}
                      style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, minWidth: 96, padding: '8px 10px', border: `1.5px solid ${border}`, borderRadius: 8, background: 'var(--surface-1)', textDecoration: 'none', textAlign: 'center' }}
                    >
                      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{n.name}</span>
                      <span style={{ fontSize: 'var(--font-size-caption)', color: isApp ? 'var(--accent)' : isRoot ? 'var(--color-trigger-sla-breach)' : 'var(--text-muted)', textTransform: 'capitalize' }}>{label}</span>
                    </Link>
                    {idx < pathModal.path.length - 1 && (
                      <span style={{ color: 'var(--text-muted)', fontSize: 18, padding: '0 2px' }}>→</span>
                    )}
                  </div>
                )
              })}
            </div>
            <p style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)', margin: '14px 0 0 0' }}>
              {t('pages.incidents.impactedApplications.pathFooter')}
            </p>
          </div>
        )}
      </Modal>
    </PageContainer>
  )
}
