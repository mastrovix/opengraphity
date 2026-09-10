import { useState } from 'react'
import { useConfirm } from '@/hooks/useConfirm'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionCard } from '@/components/ui/SectionCard'
import { GET_PROBLEM, GET_USERS, GET_TEAMS, GET_ALL_CIS, GET_ITIL_CI_RELATION_RULES } from '@/graphql/queries'
import {
  UPDATE_PROBLEM,
  LINK_INCIDENT_TO_PROBLEM,
  UNLINK_INCIDENT_FROM_PROBLEM,
  LINK_RESOLVED_TICKET,
  LINK_RELATED_TICKET,
  UNLINK_RELATED_TICKET,
  UNLINK_RESOLVED_TICKET,
  ADD_CI_TO_PROBLEM,
  REMOVE_CI_FROM_PROBLEM,
  ASSIGN_PROBLEM_TO_TEAM,
  ASSIGN_PROBLEM_TO_USER,
  EXECUTE_PROBLEM_TRANSITION,
  ADD_PROBLEM_COMMENT,
  DELETE_PROBLEM,
} from '@/graphql/mutations'
import { ProblemHeader } from './ProblemHeader'
import { WorkflowTimeline } from '@/components/ticket/WorkflowTimeline'
import { AffectedCIList } from '@/components/ticket/AffectedCIList'
import { CommentsSection } from '@/components/ticket/CommentsSection'
import { UnifiedLinkedTickets, type LinkedTicketItem } from '@/components/UnifiedLinkedTickets'
import { WatcherBar } from '@/components/WatcherBar'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { InternalChatPanel } from '@/components/InternalChatPanel'
import { keycloak } from '@/lib/keycloak'
import { downloadPdf } from '@/lib/downloadPdf'
import { FileDown, Loader2, Trash2 } from 'lucide-react'
import { DetailField } from '@/components/ui/DetailField'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { formatDate, timeAgo, PRIORITY_COLOR, STATUS_BG, STATUS_FG } from './ProblemCard'
import { colors, lookupOrError } from '@/lib/tokens'
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


interface ProblemComment {
  id:        string
  text:      string
  type:      string
  createdAt: string
  author:    { id: string; name: string } | null
}

interface Problem {
  id:                   string
  number:               string
  title:                string
  description:          string | null
  priority:             string
  status:               string
  rootCause:            string | null
  workaround:           string | null
  affectedUsers:        number | null
  createdAt:            string
  updatedAt:            string | null
  resolvedAt:           string | null
  createdBy:            { id: string; name: string } | null
  assignee:             { id: string; name: string; email: string } | null
  assignedTeam:         { id: string; name: string } | null
  affectedCIs:          CIRef[]
  linkedIncidents?:     LinkedTicketItem[]
  linkedProblems?:      LinkedTicketItem[]
  linkedChanges?:       LinkedTicketItem[]
  workflowInstance:     WorkflowInstance | null
  availableTransitions: WorkflowTransition[]
  workflowHistory:      WorkflowStepExecution[]
  comments:             ProblemComment[]
}

interface Team  { id: string; name: string }
interface User  { id: string; name: string; email: string; teams: { id: string; name: string }[] }

// ── Main component ────────────────────────────────────────────────────────────

export function ProblemDetailPage() {
  const { t }    = useTranslation()
  const confirm  = useConfirm()
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [pendingTransition,      setPendingTransition]      = useState<WorkflowTransition | null>(null)
  const [transitionNotes,        setTransitionNotes]        = useState('')
  const [isTransitionDialogOpen, setIsTransitionDialogOpen] = useState(false)

  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [showReassign,   setShowReassign]   = useState(false)

  const [ciSearch,      setCiSearch]      = useState('')

  const [editRootCause,     setEditRootCause]     = useState<string | null>(null)
  const [editWorkaround,    setEditWorkaround]    = useState<string | null>(null)
  const [editAffectedUsers, setEditAffectedUsers] = useState<string | null>(null)

  const [timelineOpen,   setTimelineOpen]   = useState(true)

  const [exportingPdf, setExportingPdf] = useState(false)

  const { data, loading, error, refetch } = useQuery<{ problem: Problem | null }>(GET_PROBLEM, { variables: { id }, skip: !id })
  const { data: usersData }        = useQuery<{ users: User[] }>(GET_USERS)
  const { data: teamsData }        = useQuery<{ teams: Team[] }>(GET_TEAMS)

  const { data: ciRulesData } = useQuery<{ itilCIRelationRules: { id: string; ciType: string; relationType: string; direction: string; description: string | null }[] }>(
    GET_ITIL_CI_RELATION_RULES,
    { variables: { itilType: 'problem' }, fetchPolicy: 'network-only' },
  )

  const ciTypesFilter = ciRulesData?.itilCIRelationRules?.length
    ? [...new Set(ciRulesData.itilCIRelationRules.map(r => r.ciType.toLowerCase()))]
    : undefined

  const { data: ciSearchData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20, ciTypes: ciTypesFilter },
    skip: ciSearch.length < 2 || ciRulesData === undefined,
  })

  const [updateProblem] = useMutation(UPDATE_PROBLEM, {
    onCompleted: () => { toast.success(t('toast.problem.updated')); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [execTransition, { loading: transitioning }] = useMutation<{ executeProblemTransition?: { actionErrors?: string[] | null } }>(EXECUTE_PROBLEM_TRANSITION, {
    onCompleted: (data) => {
      const errs = data?.executeProblemTransition?.actionErrors
      if (errs?.length) toast.warning(t('toast.problem.transitionPartial', { count: errs.length, errors: errs.join(' · ') }), { duration: 10000 })
      else toast.success(t('toast.problem.transitionCompleted'))
      setIsTransitionDialogOpen(false); setPendingTransition(null); setTransitionNotes(''); void refetch()
    },
    onError: (err) => toast.error(err.message),
  })

  const [assignToTeam, { loading: assigningTeam }] = useMutation(ASSIGN_PROBLEM_TO_TEAM, {
    onCompleted: () => { toast.success(t('toast.problem.teamAssigned')); setSelectedTeamId(''); setShowReassign(false); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [assignToUser, { loading: assigningUser }] = useMutation(ASSIGN_PROBLEM_TO_USER, {
    onCompleted: () => { toast.success(t('toast.problem.userAssigned')); setSelectedUserId(''); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [addCI] = useMutation(ADD_CI_TO_PROBLEM, {
    onCompleted: () => { toast.success(t('toast.problem.ciAdded')); setCiSearch(''); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [removeCI] = useMutation(REMOVE_CI_FROM_PROBLEM, {
    onCompleted: () => { toast.success(t('toast.problem.ciRemoved')); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [linkIncident] = useMutation(LINK_INCIDENT_TO_PROBLEM, {
    onCompleted: () => { toast.success(t('toast.problem.incidentLinked')); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [unlinkIncident] = useMutation(UNLINK_INCIDENT_FROM_PROBLEM, {
    onCompleted: () => { toast.success(t('toast.problem.incidentUnlinked')); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  // Collegamento change: stesso percorso dell'incident (linkResolvedTicket),
  // niente più linkChangeToProblem (doppione che non marcava auto e non
  // filtrava le change eliminate).
  const [linkResolved] = useMutation(LINK_RESOLVED_TICKET, {
    onCompleted: () => { toast.success(t('toast.problem.changeLinked')); void refetch() },
    onError: (err) => toast.error(err.message),
  })
  const relLinkOpts = { onError: (e: { message: string }) => toast.error(e.message), onCompleted: () => { void refetch() } }
  const [linkRelated]   = useMutation(LINK_RELATED_TICKET, relLinkOpts)
  const [unlinkRelated] = useMutation(UNLINK_RELATED_TICKET, relLinkOpts)
  const [unlinkResolved] = useMutation(UNLINK_RESOLVED_TICKET, relLinkOpts)

  const [addComment, { loading: addingComment }] = useMutation(ADD_PROBLEM_COMMENT, {
    onCompleted: () => { toast.success(t('toast.problem.commentAdded')); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [deleteProblem, { loading: deleting }] = useMutation(DELETE_PROBLEM, {
    onCompleted: () => { toast.success(t('toast.problem.deleted')); navigate('/problems') },
    onError: (err) => toast.error(err.message),
  })

  const problem         = data?.problem
  const users           = usersData?.users ?? []
  const teams           = teamsData?.teams ?? []
  const ciRules         = ciRulesData?.itilCIRelationRules ?? []
  const ciResults       = ciSearchData?.allCIs?.items ?? []

  function handleTransitionClick(tr: WorkflowTransition) {
    // "Richiedi Change": non è una semplice transizione — apre la creazione di
    // una RFC risolutiva. Alla creazione la change viene collegata al problem e
    // il workflow avanza a change_requested (lato backend).
    if (tr.toStep === 'change_requested') {
      if (!problem) return
      navigate(`/changes/new?problemId=${problem.id}`)
      return
    }
    if (tr.requiresInput) {
      setPendingTransition(tr)
      setTransitionNotes('')
      setIsTransitionDialogOpen(true)
    } else {
      if (!problem) return
      void execTransition({ variables: { problemId: problem.id, toStep: tr.toStep } })
    }
  }

  async function handleExportPdf() {
    if (!problem) return
    setExportingPdf(true)
    try {
      await downloadPdf(`/api/problems/${problem.id}/pdf`, `${problem.number || problem.id}.pdf`)
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>
          <div className="space-y-4"><Skeleton style={{ height: 120 }} /><Skeleton style={{ height: 160 }} /></div>
          <div className="space-y-4"><Skeleton style={{ height: 200 }} /><Skeleton style={{ height: 240 }} /></div>
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

  if (!problem) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 'var(--font-size-body)' }}>
        {t('pages.problems.notFound')}{' '}
        <button type="button" onClick={() => navigate('/problems')} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
          {t('detail.backToList')}
        </button>
      </div>
    )
  }

  const manualTransitions = problem.availableTransitions
  const historyDesc       = [...problem.workflowHistory].reverse()

  return (
    <PageContainer>

      <ProblemHeader
        problem={problem}
        manualTransitions={manualTransitions}
        transitioning={transitioning}
        onBack={() => navigate(-1)}
        onTransitionClick={handleTransitionClick}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Button
          variant="secondary"
          disabled={exportingPdf}
          icon={exportingPdf ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
          onClick={() => void handleExportPdf()}
        >
          {t('detail.exportPdf')}
        </Button>
        <Button
          variant="secondary"
          disabled={deleting}
          icon={<Trash2 size={13} />}
          onClick={() => {
            void confirm({ title: `Eliminare definitivamente il problem ${problem.number || ''}?`, body: t('confirm.irreversible'), danger: true }).then((ok) => {
              if (ok) void deleteProblem({ variables: { id: problem.id } })
            })
          }}
        >
          Elimina
        </Button>
        <WatcherBar entityType="problem" entityId={problem.id} />
      </div>

      {/* Body grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left column */}
        <div>

          {/* Dettagli */}
          <SectionCard title={t('detail.sections.problemInformation')} defaultOpen>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <DetailField label={t('detail.ticketNumber')} value={<span style={{ fontWeight: 600 }}>{problem.number}</span>} />
              <DetailField label={t('detail.sections.description')} value={
                problem.description
                  ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>{problem.description}</p>
                  : <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: 0 }}>{t('detail.noDescription')}</p>
              } />
              <DetailField label={t('detail.priority')} value={
                <span style={{ fontWeight: 600, color: lookupOrError(PRIORITY_COLOR, problem.priority, 'PRIORITY_COLOR', 'var(--color-slate)') }}>{problem.priority}</span>
              } />
              <DetailField label={t('detail.workflowStep')} value={
                <Pill bg={lookupOrError(STATUS_BG, problem.status, 'STATUS_BG', 'var(--color-border-light)')} color={lookupOrError(STATUS_FG, problem.status, 'STATUS_FG', 'var(--color-slate)')} radius={4} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
                  {problem.workflowInstance?.currentStep.replace(/_/g, ' ') ?? problem.status.replace(/_/g, ' ')}
                </Pill>
              } />

              {/* Team assignment */}
              <DetailField label={t('detail.assignedTeam')} value={
                problem.assignedTeam && !showReassign ? (
                  <div>
                    <div style={{ fontWeight: 500 }}>{problem.assignedTeam.name}</div>
                    <button type="button" onClick={() => setShowReassign(true)} style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, fontSize: 'var(--font-size-body)', color: 'var(--accent)', cursor: 'pointer' }}>{t('detail.reassign')}</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Select value={selectedTeamId} onChange={(e) => setSelectedTeamId(e.target.value)} style={{ padding: '7px 10px', border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)', background: 'var(--surface)' }}>
                      <option value="">{t('detail.selectTeam')}</option>
                      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {showReassign && (
                        <button type="button" onClick={() => setShowReassign(false)} style={{ flex: 1, padding: '6px 0', background: 'none', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', cursor: 'pointer' }}>{t('common.cancel')}</button>
                      )}
                      <button type="button" disabled={!selectedTeamId || assigningTeam} onClick={() => { if (!selectedTeamId) return; void assignToTeam({ variables: { problemId: problem.id, teamId: selectedTeamId } }) }} style={{ flex: 1, padding: '6px 0', backgroundColor: (!selectedTeamId || assigningTeam) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedTeamId || assigningTeam) ? 'var(--text-muted)' : colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: (!selectedTeamId || assigningTeam) ? 'not-allowed' : 'pointer' }}>
                        {assigningTeam ? t('detail.assigning') : t('detail.assign')}
                      </button>
                    </div>
                  </div>
                )
              } />

              {/* User assignment */}
              <DetailField label={t('detail.assignedTo')} value={
                problem.assignee ? (
                  <div>
                    <div style={{ fontWeight: 500 }}>{problem.assignee.name}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>{problem.assignee.email}</div>
                  </div>
                ) : !problem.assignedTeam ? (
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    Assegna prima un gruppo per poter scegliere un utente.
                  </span>
                ) : (() => {
                  const teamUsers = users.filter((u) => u.teams?.some((tm) => tm.id === problem.assignedTeam!.id))
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <Select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} style={{ padding: '7px 10px', border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)', background: 'var(--surface)' }}>
                        <option value="">{t('detail.selectUser')}</option>
                        {teamUsers.map((u) => (
                          <option key={u.id} value={u.id}>{u.name}</option>
                        ))}
                      </Select>
                      {teamUsers.length === 0 && (
                        <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          Nessun utente nel gruppo {problem.assignedTeam.name}.
                        </span>
                      )}
                      <button type="button" disabled={!selectedUserId || assigningUser} onClick={() => { if (!selectedUserId) return; void assignToUser({ variables: { problemId: problem.id, userId: selectedUserId } }) }} style={{ padding: '6px 0', backgroundColor: (!selectedUserId || assigningUser) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedUserId || assigningUser) ? 'var(--text-muted)' : colors.white, border: 'none', borderRadius: 6, fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: (!selectedUserId || assigningUser) ? 'not-allowed' : 'pointer' }}>
                        {assigningUser ? t('detail.assigning') : t('detail.assign')}
                      </button>
                    </div>
                  )
                })()
              } />

              {/* Affected users */}
              <DetailField label={t('detail.affectedUsers')} value={
                <Input
                  type="number"
                  value={editAffectedUsers ?? (problem.affectedUsers?.toString() ?? '')}
                  onChange={(e) => setEditAffectedUsers(e.target.value)}
                  onBlur={() => {
                    const val = editAffectedUsers
                    const num = val !== null ? parseInt(val, 10) : null
                    if (val !== null && num !== problem.affectedUsers) {
                      void updateProblem({ variables: { id: problem.id, input: { affectedUsers: num ?? undefined } } })
                    }
                    setEditAffectedUsers(null)
                  }}
                  placeholder="0"
                  min={0}
                  style={{ padding: '5px 8px', border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)' }}
                />
              } />

              {problem.createdBy && (
                <DetailField label={t('detail.createdBy')} value={<span style={{ fontWeight: 500 }}>{problem.createdBy.name}</span>} />
              )}
              <DetailField label={t('detail.createdAt')} value={formatDate(problem.createdAt)} />
              {problem.updatedAt && <DetailField label={t('detail.updatedAt')} value={timeAgo(problem.updatedAt)} />}
              {problem.resolvedAt && <DetailField label={t('detail.resolvedAt')} value={formatDate(problem.resolvedAt)} />}
            </div>
          </SectionCard>

          {/* Root Cause */}
          <SectionCard title="Root Cause" collapsible defaultOpen={false}>
                <Textarea
                  value={editRootCause ?? (problem.rootCause ?? '')}
                  onChange={(e) => setEditRootCause(e.target.value)}
                  onBlur={() => {
                    const val = editRootCause
                    if (val !== null && val !== problem.rootCause) {
                      void updateProblem({ variables: { id: problem.id, input: { rootCause: val } } })
                    }
                    setEditRootCause(null)
                  }}
                  placeholder="Descrivi la causa radice del problema..."
                  rows={4}
                  style={{ padding: '8px 12px', border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)' }}
                />
          </SectionCard>

          {/* Workaround */}
          <SectionCard title="Workaround" collapsible defaultOpen={false}>
                <Textarea
                  value={editWorkaround ?? (problem.workaround ?? '')}
                  onChange={(e) => setEditWorkaround(e.target.value)}
                  onBlur={() => {
                    const val = editWorkaround
                    if (val !== null && val !== problem.workaround) {
                      void updateProblem({ variables: { id: problem.id, input: { workaround: val } } })
                    }
                    setEditWorkaround(null)
                  }}
                  placeholder="Descrivi il workaround temporaneo..."
                  rows={3}
                  style={{ padding: '8px 12px', border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)' }}
                />
          </SectionCard>

          <AffectedCIList
            affectedCIs={problem.affectedCIs}
            ciResults={ciResults}
            rules={ciRules}
            onSearchChange={setCiSearch}
            onAddCI={(ciId, relationType) => void addCI({ variables: { problemId: problem.id, ciId, relationType } })}
            onRemoveCI={(ciId) => void removeCI({ variables: { problemId: problem.id, ciId } })}
          />

          {/* Ticket collegati (sezione unica, stile change) */}
          <UnifiedLinkedTickets
            title="Ticket collegati"
            excludeId={problem.id}
            types={[
              {
                kind: 'INCIDENT', label: 'Incident', routeBase: '/incidents',
                items: problem.linkedIncidents ?? [],
                onLink: (incidentId) => void linkIncident({ variables: { problemId: problem.id, incidentId } }),
                onUnlink: (incidentId) => void unlinkIncident({ variables: { problemId: problem.id, incidentId } }),
              },
              {
                kind: 'PROBLEM', label: 'Problem', routeBase: '/problems',
                items: problem.linkedProblems ?? [],
                onLink: (otherId) => void linkRelated({ variables: { entityType: 'problem', entityId: problem.id, otherId } }),
                onUnlink: (otherId) => void unlinkRelated({ variables: { entityType: 'problem', entityId: problem.id, otherId } }),
              },
              {
                kind: 'CHANGE', label: 'Change', routeBase: '/changes',
                items: problem.linkedChanges ?? [],
                onLink: (changeId) => void linkResolved({ variables: { changeId, entityType: 'problem', entityId: problem.id } }),
                onUnlink: (changeId) => void unlinkResolved({ variables: { changeId, entityType: 'problem', entityId: problem.id } }),
              },
            ]}
          />

          {/* Allegati */}
          <AttachmentsSection entityType="problem" entityId={problem.id} defaultOpen={false} />

          {/* Commenti */}
          <CommentsSection
            comments={problem.comments}
            adding={addingComment}
            onAdd={(text) => addComment({ variables: { problemId: problem.id, text } })}
          />

          <InternalChatPanel
            entityType="problem"
            entityId={problem.id}
            currentUserId={keycloak.subject ?? ''}
          />
        </div>

        {/* Right column */}
        <div>

          {/* Timeline workflow (come nell'incident) */}
          <WorkflowTimeline
            historyDesc={historyDesc}
            timelineOpen={timelineOpen}
            onToggle={() => setTimelineOpen((p) => !p)}
          />

        </div>
      </div>

      {/* Transition Dialog */}
      {isTransitionDialogOpen && pendingTransition && (
        <Modal
          open
          onClose={() => { setIsTransitionDialogOpen(false); setTransitionNotes('') }}
          title={`Transizione → ${pendingTransition.toStep.replace(/_/g, ' ')}`}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => { setIsTransitionDialogOpen(false); setTransitionNotes('') }}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', fontSize: 'var(--font-size-card-title)', fontWeight: 500 }}
              >
                Annulla
              </Button>
              <Button
                disabled={transitioning || transitionNotes.trim().length < 10}
                onClick={() => {
                  if (transitionNotes.trim().length < 10) { toast.error(t('toast.problem.notesTooShort')); return }
                  void execTransition({ variables: { problemId: problem.id, toStep: pendingTransition.toStep, notes: transitionNotes.trim() } })
                }}
                style={{ padding: '8px 16px', borderRadius: 8, fontSize: 'var(--font-size-card-title)', fontWeight: 500, backgroundColor: transitionNotes.trim().length >= 10 ? 'var(--accent)' : 'var(--surface-2)', color: transitionNotes.trim().length >= 10 ? colors.white : 'var(--text-muted)' }}
              >
                {transitioning ? 'Esecuzione...' : 'Conferma'}
              </Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', marginBottom: 16, marginTop: 0 }}>
            Aggiungi una nota per questa transizione (minimo 10 caratteri).
          </p>
          <Textarea
            value={transitionNotes}
            onChange={(e) => setTransitionNotes(e.target.value)}
            placeholder="Note sulla transizione..."
            rows={4}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management: textarea del dialogo di transizione aperto dall'utente
            autoFocus
            style={{ resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
          />
        </Modal>
      )}
    </PageContainer>
  )
}
