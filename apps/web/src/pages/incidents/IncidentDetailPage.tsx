import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FileDown, Loader2 } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/QueryError'
import { Label } from '@/components/ui/label'
import { Modal } from '@/components/Modal'
import { SectionCard } from '@/components/ui/SectionCard'
import { SeverityBadge } from '@/components/SeverityBadge'
import { GET_INCIDENT, GET_USERS, GET_TEAMS, GET_ALL_CIS, GET_ITIL_CI_RELATION_RULES } from '@/graphql/queries'
import { EXECUTE_WORKFLOW_TRANSITION, ASSIGN_INCIDENT_TO_TEAM, ASSIGN_INCIDENT_TO_USER, ADD_INCIDENT_COMMENT, ADD_AFFECTED_CI, REMOVE_AFFECTED_CI } from '@/graphql/mutations'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { IncidentHeader } from './IncidentHeader'
import { IncidentTimeline } from './IncidentTimeline'
import { IncidentCIList } from './IncidentCIList'
import { WatcherBar } from '@/components/WatcherBar'
import { SlaBadge, type SlaStatusInfo } from '@/components/SlaBadge'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { InternalChatPanel } from '@/components/InternalChatPanel'
import { MentionInput } from '@/components/MentionInput'
import { MentionText } from '@/components/MentionText'
import { keycloak } from '@/lib/keycloak'
import { downloadPdf } from '@/lib/downloadPdf'
import { Button } from '@/components/Button'
import { DetailField } from '@/components/ui/DetailField'
import { Select, Textarea } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { formatDate, timeAgo } from './IncidentCard'

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

interface Team { id: string; name: string }

interface Incident {
  id:                   string
  number:               string
  title:                string
  description:          string | null
  severity:             string
  status:               string
  rootCause:            string | null
  createdAt:            string
  updatedAt:            string
  resolvedAt:           string | null
  assignee:             { id: string; name: string; email: string } | null
  assignedTeam:         Team | null
  affectedCIs:          CIRef[]
  workflowInstance:     WorkflowInstance | null
  availableTransitions: WorkflowTransition[]
  workflowHistory:      WorkflowStepExecution[]
  comments:             Comment[]
  slaStatus:            SlaStatusInfo | null
}

interface Comment {
  id:        string
  text:      string
  createdAt: string
  updatedAt: string
  author:    { id: string; name: string; email: string } | null
}

interface User { id: string; name: string; email: string; teams: { id: string; name: string }[] }

// ── Main component ────────────────────────────────────────────────────────────

export function IncidentDetailPage() {
  const { t }    = useTranslation()
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

  const [commentText, setCommentText] = useState('')
  const [exportingPdf, setExportingPdf] = useState(false)

  const [ciSearch,      setCiSearch]      = useState('')
  const [showCISearch,  setShowCISearch]  = useState(false)

  const [ciOpen,       setCiOpen]       = useState(true)
  const [timelineOpen, setTimelineOpen] = useState(true)

  const { data, loading, error, refetch } = useQuery<{ incident: Incident | null }>(
    GET_INCIDENT,
    { variables: { id }, skip: !id },
  )
  const { data: usersData } = useQuery<{ users: User[] }>(GET_USERS)
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS)
  const { data: ciRulesData } = useQuery<{ itilCIRelationRules: { id: string; ciType: string; relationType: string; direction: string; description: string | null }[] }>(
    GET_ITIL_CI_RELATION_RULES,
    { variables: { itilType: 'incident' }, fetchPolicy: 'network-only' },
  )

  const ciTypesFilter = ciRulesData?.itilCIRelationRules?.length
    ? [...new Set(ciRulesData.itilCIRelationRules.map(r => r.ciType.toLowerCase()))]
    : undefined

  const { data: ciSearchData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20, ciTypes: ciTypesFilter },
    skip: ciSearch.length < 2 || ciRulesData === undefined,
  })

  const [execTransition, { loading: transitioning }] = useMutation<{
    executeWorkflowTransition: { success: boolean; error: string | null; instance: { currentStep: string } }
  }>(EXECUTE_WORKFLOW_TRANSITION, {
    onCompleted: (res) => {
      const r = res.executeWorkflowTransition
      if (r.success) {
        toast.success(`Transizione completata → ${r.instance.currentStep}`)
        setIsTransitionDialogOpen(false)
        setPendingTransition(null)
        setTransitionNotes('')
        void refetch()
      } else {
        toast.error(r.error ?? 'Transizione fallita')
      }
    },
    onError: (err) => toast.error(err.message),
  })

  const [assignToTeam, { loading: assigningTeam }] = useMutation(ASSIGN_INCIDENT_TO_TEAM, {
    onCompleted: (_data, opts) => {
      toast.success('Team assegnato')
      setSelectedTeamId('')
      setShowReassign(false)
      setSelectedUserId('')
      const incidentId = (opts?.variables as { id?: string } | undefined)?.id
      if (incidentId) {
        void assignToUser({ variables: { id: incidentId, userId: null } })
          .then(() => { setAwaitingUserAssign(true); void refetch() })
          .catch(() => { setAwaitingUserAssign(true); void refetch() })
      } else {
        setAwaitingUserAssign(true)
        void refetch()
      }
    },
    onError: (err) => toast.error(err.message),
  })

  const [assignToUser, { loading: assigningUser }] = useMutation(ASSIGN_INCIDENT_TO_USER, {
    onCompleted: (_data, opts) => {
      const userId = (opts?.variables as { userId?: string | null } | undefined)?.userId
      if (userId) {
        toast.success('Incident preso in carico')
        setAwaitingUserAssign(false)
        setSelectedUserId('')
        void refetch()
      }
    },
    onError: (err) => toast.error(err.message),
  })

  const [addComment, { loading: addingComment }] = useMutation(ADD_INCIDENT_COMMENT, {
    onCompleted: () => {
      toast.success('Commento aggiunto')
      setCommentText('')
      void refetch()
    },
    onError: (err) => toast.error(err.message),
  })

  const [addCI] = useMutation(ADD_AFFECTED_CI, {
    onCompleted: () => { toast.success('CI aggiunto'); setCiSearch(''); setShowCISearch(false); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const ciRules = ciRulesData?.itilCIRelationRules ?? []

  const [removeCI] = useMutation(REMOVE_AFFECTED_CI, {
    onCompleted: () => { toast.success('CI rimosso'); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const incident  = data?.incident
  const users     = usersData?.users ?? []
  const teams     = teamsData?.teams ?? []
  const ciResults = ciSearchData?.allCIs?.items ?? []
  const { byName: incidentStepByName, error: workflowStepsError } = useWorkflowSteps('incident')

  function handleTransitionClick(tr: WorkflowTransition) {
    // Guard rails come from the workflow definition: if it failed to load we
    // cannot evaluate the gates, so refuse to proceed instead of skipping them.
    if (workflowStepsError) {
      toast.error('Regole di workflow non caricate: ' + workflowStepsError.message)
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
      toast.error('Seleziona prima un team dalla card Dettagli')
      return
    }
    if (targetMeta?.category === 'active' && !currentMeta?.isInitial && !incident?.assignee && incident?.assignedTeam) {
      toast.error('Seleziona prima un utente dalla card Dettagli')
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

  if (loading) {
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
          onClick={() => navigate('/incidents')}
          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}
        >
          {t('detail.backToList')}
        </button>
      </div>
    )
  }

  const manualTransitions = incident.availableTransitions.filter((t) => t.toStep !== undefined)
  const historyDesc       = [...incident.workflowHistory].reverse()

  return (
    <PageContainer>

      {/* Header + action buttons */}
      <IncidentHeader
        incident={incident}
        manualTransitions={manualTransitions}
        transitioning={transitioning}
        onBack={() => navigate(-1)}
        onTransitionClick={handleTransitionClick}
      />

      {/* Watchers bar + PDF export */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
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

      {/* Body grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left column */}
        <div>

          {/* Descrizione */}
          <SectionCard title={t('detail.sections.description')} defaultOpen>
            {incident.description ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>{incident.description}</p>
            ) : (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: 0 }}>{t('detail.noDescription')}</p>
            )}
          </SectionCard>

          {/* Dettagli */}
          <SectionCard title={t('detail.sections.details')} defaultOpen>
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <DetailField label={t('pages.incidents.severity')} value={<SeverityBadge value={incident.severity} />} />
                  <DetailField label={t('sla.title')} value={
                    incident.slaStatus
                      ? <SlaBadge sla={incident.slaStatus} />
                      : <span style={{ color: 'var(--text-muted)' }}>{t('sla.none')}</span>
                  } />
                  <DetailField label={t('detail.workflowStep')} value={
                    <Pill bg="var(--color-brand-light)" color="var(--color-brand)" radius={100} style={{ fontSize: 'var(--font-size-body)', textTransform: 'capitalize' }}>
                      {incident.workflowInstance?.currentStep.replace(/_/g, ' ') ?? 'N/D'}
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
                      <DetailField label="Root Cause" value={incident.rootCause} />
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
                        <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--text-muted)' }}>{t('detail.team')}</label>
                        <Select
                          value={selectedTeamId}
                          onChange={(e) => setSelectedTeamId(e.target.value)}
                          style={{ padding: '8px 10px', border: '1px solid var(--border)', color: 'var(--text-primary)', background: 'var(--surface)' }}
                        >
                          <option value="">{t('detail.selectTeam')}</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </Select>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {showReassign && (
                            <button onClick={() => setShowReassign(false)} style={{ flex: 1, padding: '7px 0', background: 'none', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                              {t('common.cancel')}
                            </button>
                          )}
                          <button
                            disabled={!selectedTeamId || !selectedTeamId.trim() || assigningTeam}
                            onClick={() => {
                              if (!selectedTeamId) return
                              void assignToTeam({ variables: { id: incident.id, teamId: selectedTeamId } })
                              setShowReassign(false)
                            }}
                            style={{ flex: 1, padding: '7px 0', backgroundColor: (!selectedTeamId || assigningTeam) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedTeamId || assigningTeam) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: (!selectedTeamId || assigningTeam) ? 'not-allowed' : 'pointer' }}
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
                      <label style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--text-muted)' }}>{t('detail.assignedTo')}</label>
                      <Select
                        value={selectedUserId}
                        onChange={(e) => setSelectedUserId(e.target.value)}
                        style={{ padding: '8px 10px', border: '1px solid var(--border)', color: 'var(--text-primary)', background: 'var(--surface)' }}
                      >
                        <option value="">{t('detail.selectUser')}</option>
                        {teamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </Select>
                      <button
                        disabled={!selectedUserId || !selectedUserId.trim() || assigningUser}
                        onClick={() => {
                          if (!selectedUserId) return
                          void assignToUser({ variables: { id: incident.id, userId: selectedUserId } })
                        }}
                        style={{ padding: '7px 0', backgroundColor: (!selectedUserId || assigningUser) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedUserId || assigningUser) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: (!selectedUserId || assigningUser) ? 'not-allowed' : 'pointer' }}
                      >
                        {assigningUser ? t('detail.assigning') : t('detail.takeOwnership')}
                      </button>
                    </div>
                  )
                })()}
            </div>
          </SectionCard>

          {/* CI Impattati */}
          <IncidentCIList
            incidentId={incident.id}
            affectedCIs={incident.affectedCIs}
            ciOpen={ciOpen}
            showCISearch={showCISearch}
            ciSearch={ciSearch}
            ciResults={ciResults}
            rules={ciRules}
            onToggle={() => setCiOpen((p) => !p)}
            onToggleSearch={(e) => { e.stopPropagation(); setShowCISearch((s) => !s); if (!ciOpen) setCiOpen(true) }}
            onSearchChange={setCiSearch}
            onAddCI={(ciId, relationType) => void addCI({ variables: { incidentId: incident.id, ciId, relationType } })}
            onRemoveCI={(ciId) => void removeCI({ variables: { incidentId: incident.id, ciId } })}
          />

          {/* Allegati */}
          <AttachmentsSection entityType="incident" entityId={incident.id} />

          {/* Commenti */}
          <SectionCard title={t('detail.sections.comments')} count={incident.comments.length} defaultOpen>
            <div>
                {incident.comments.length === 0 ? (
                  <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: '0 0 16px 0' }}>{t('detail.noCommentsYet')}</p>
                ) : (
                  <div style={{ marginBottom: 16 }}>
                    {incident.comments.slice().reverse().map((c, i) => (
                      <div key={c.id}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0' }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', backgroundColor: 'var(--color-brand-light)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-body)', fontWeight: 700, flexShrink: 0 }}>
                            {c.author ? c.author.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '?'}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 }}>
                              <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{c.author?.name ?? t('detail.unknownUser')}</span>
                              <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>{timeAgo(c.createdAt)}</span>
                            </div>
                            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}><MentionText text={c.text} /></p>
                          </div>
                        </div>
                        {i < incident.comments.length - 1 && (
                          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0 0 16px 0' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Label style={{ fontSize: 'var(--font-size-body)' }}>{t('detail.writeComment')}</Label>
                  <MentionInput value={commentText} onChange={setCommentText} placeholder={t('detail.commentPlaceholder')} rows={3} />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      disabled={!commentText.trim() || addingComment}
                      onClick={() => void addComment({ variables: { id: incident.id, text: commentText.trim() } })}
                      style={{ padding: '7px 16px', backgroundColor: (commentText.trim() && !addingComment) ? 'var(--accent)' : 'var(--surface-2)', color: (commentText.trim() && !addingComment) ? '#fff' : 'var(--text-muted)', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: (commentText.trim() && !addingComment) ? 'pointer' : 'not-allowed' }}
                    >
                      {addingComment ? t('detail.sending') : t('detail.sendComment')}
                    </button>
                  </div>
                </div>
            </div>
          </SectionCard>

          {/* Internal Chat (agents only) */}
          <InternalChatPanel
            entityType="incident"
            entityId={incident.id}
            currentUserId={keycloak.subject ?? ''}
          />
        </div>

        {/* Right column */}
        <div>
          <IncidentTimeline
            historyDesc={historyDesc}
            timelineOpen={timelineOpen}
            onToggle={() => setTimelineOpen((p) => !p)}
          />
        </div>
      </div>

      {/* Transition Dialog */}
      <Modal
        open={isTransitionDialogOpen && !!pendingTransition}
        onClose={() => { setIsTransitionDialogOpen(false); setTransitionNotes(''); setNotesError('') }}
        title={
          pendingTransition?.inputField === 'rootCause'
            ? 'Root Cause Analysis'
            : `Transizione → ${pendingTransition?.toStep ?? ''}`
        }
        width={480}
        footer={
          <>
            <button
              onClick={() => { setIsTransitionDialogOpen(false); setTransitionNotes(''); setNotesError('') }}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500 }}
            >
              Annulla
            </button>
            <button
              onClick={() => {
                if (transitionNotes.trim().length < 10) return
                if (!incident?.workflowInstance?.id) { toast.error('WorkflowInstance non trovato'); return }
                if (!pendingTransition?.toStep) { toast.error('Transizione non selezionata'); return }
                void execTransition({
                  variables: {
                    instanceId: incident.workflowInstance.id,
                    toStep: pendingTransition.toStep,
                    notes: transitionNotes.trim(),
                  },
                  onCompleted: (data) => {
                    if (data.executeWorkflowTransition.success) {
                      toast.success('Transizione eseguita')
                      setIsTransitionDialogOpen(false)
                      setPendingTransition(null)
                      setTransitionNotes('')
                      void refetch()
                    } else {
                      toast.error(data.executeWorkflowTransition.error ?? 'Errore transizione')
                    }
                  },
                  onError: (err) => toast.error(err.message),
                })
              }}
              style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-card-title)', fontWeight: 500, backgroundColor: transitionNotes.trim().length >= 10 ? 'var(--accent)' : 'var(--surface-2)', color: transitionNotes.trim().length >= 10 ? '#fff' : 'var(--text-muted)' }}
            >
              {transitioning ? 'Esecuzione...' : 'Conferma'}
            </button>
          </>
        }
      >
        {pendingTransition && (
          <>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', marginBottom: 16, marginTop: 0 }}>
              {pendingTransition.inputField === 'rootCause'
                ? 'Descrivi la causa radice prima di risolvere (minimo 10 caratteri).'
                : 'Aggiungi una nota per questa transizione (minimo 10 caratteri).'}
            </p>
            <Textarea
              value={transitionNotes}
              onChange={(e) => { setTransitionNotes(e.target.value); setNotesError('') }}
              placeholder={pendingTransition.inputField === 'rootCause' ? 'Es: Memory leak in payment-service v2.3.1...' : 'Note sulla transizione...'}
              rows={4}
              style={{ resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
              autoFocus
            />
            {notesError && (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)', margin: '6px 0 0 0' }}>{notesError}</p>
            )}
          </>
        )}
      </Modal>
    </PageContainer>
  )
}
