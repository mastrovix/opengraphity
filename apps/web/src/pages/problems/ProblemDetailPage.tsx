import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/components/ui/SectionCard'
import { GET_PROBLEM, GET_USERS, GET_TEAMS, GET_ALL_CIS, GET_INCIDENTS, GET_CHANGES, GET_ITIL_CI_RELATION_RULES } from '@/graphql/queries'
import {
  UPDATE_PROBLEM,
  LINK_INCIDENT_TO_PROBLEM,
  UNLINK_INCIDENT_FROM_PROBLEM,
  LINK_CHANGE_TO_PROBLEM,
  ADD_CI_TO_PROBLEM,
  REMOVE_CI_FROM_PROBLEM,
  ASSIGN_PROBLEM_TO_TEAM,
  ASSIGN_PROBLEM_TO_USER,
  EXECUTE_PROBLEM_TRANSITION,
  ADD_PROBLEM_COMMENT,
} from '@/graphql/mutations'
import { ProblemHeader } from './ProblemHeader'
import { ProblemTimeline } from './ProblemTimeline'
import { ProblemCIList, ProblemIncidentList, ProblemChangeList } from './ProblemLinkedEntities'
import { WatcherBar } from '@/components/WatcherBar'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { InternalChatPanel } from '@/components/InternalChatPanel'
import { MentionInput } from '@/components/MentionInput'
import { MentionText } from '@/components/MentionText'
import { keycloak } from '@/lib/keycloak'
import { downloadPdf } from '@/lib/downloadPdf'
import { FileDown, Loader2 } from 'lucide-react'
import { DetailField } from '@/components/ui/DetailField'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { Card, formatDate, timeAgo, PRIORITY_COLOR, STATUS_BG, STATUS_FG } from './ProblemCard'
import { lookupOrError } from '@/lib/tokens'

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

interface IncidentRef {
  id:        string
  title:     string
  status:    string
  severity:  string
  createdAt: string
}

interface ChangeRef {
  id:             string
  title:          string
  type:           string
  status:         string
  scheduledStart: string | null
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
  relatedIncidents:     IncidentRef[]
  relatedChanges:       ChangeRef[]
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
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [pendingTransition,      setPendingTransition]      = useState<WorkflowTransition | null>(null)
  const [transitionNotes,        setTransitionNotes]        = useState('')
  const [isTransitionDialogOpen, setIsTransitionDialogOpen] = useState(false)

  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [showReassign,   setShowReassign]   = useState(false)

  const [commentText, setCommentText] = useState('')

  const [ciSearch,      setCiSearch]      = useState('')
  const [showCISearch,  setShowCISearch]  = useState(false)

  const [incidentSearch,     setIncidentSearch]     = useState('')
  const [showIncidentSearch, setShowIncidentSearch] = useState(false)

  const [changeSearch,     setChangeSearch]     = useState('')
  const [showChangeSearch, setShowChangeSearch] = useState(false)

  const [editRootCause,     setEditRootCause]     = useState<string | null>(null)
  const [editWorkaround,    setEditWorkaround]    = useState<string | null>(null)
  const [editAffectedUsers, setEditAffectedUsers] = useState<string | null>(null)

  const [ciOpen,         setCiOpen]         = useState(true)
  const [incidentsOpen,  setIncidentsOpen]  = useState(true)
  const [changesOpen,    setChangesOpen]    = useState(true)
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

  const { data: incidentSearchData } = useQuery<{ incidents: { items: IncidentRef[] } }>(GET_INCIDENTS, {
    variables: { limit: 50 },
    skip: !showIncidentSearch,
  })

  const { data: changeSearchData } = useQuery<{ changes: { items: ChangeRef[] } }>(GET_CHANGES, {
    variables: { search: changeSearch || undefined, limit: 20 },
    skip: changeSearch.length < 2,
  })

  const [updateProblem] = useMutation(UPDATE_PROBLEM, {
    onCompleted: () => { toast.success('Aggiornato'); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [execTransition, { loading: transitioning }] = useMutation(EXECUTE_PROBLEM_TRANSITION, {
    onCompleted: () => { toast.success('Transizione completata'); setIsTransitionDialogOpen(false); setPendingTransition(null); setTransitionNotes(''); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [assignToTeam, { loading: assigningTeam }] = useMutation(ASSIGN_PROBLEM_TO_TEAM, {
    onCompleted: () => { toast.success('Team assegnato'); setSelectedTeamId(''); setShowReassign(false); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [assignToUser, { loading: assigningUser }] = useMutation(ASSIGN_PROBLEM_TO_USER, {
    onCompleted: () => { toast.success('Utente assegnato'); setSelectedUserId(''); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [addCI] = useMutation(ADD_CI_TO_PROBLEM, {
    onCompleted: () => { toast.success('CI aggiunto'); setCiSearch(''); setShowCISearch(false); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [removeCI] = useMutation(REMOVE_CI_FROM_PROBLEM, {
    onCompleted: () => { toast.success('CI rimosso'); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [linkIncident] = useMutation(LINK_INCIDENT_TO_PROBLEM, {
    onCompleted: () => { toast.success('Incident collegato'); setIncidentSearch(''); setShowIncidentSearch(false); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [unlinkIncident] = useMutation(UNLINK_INCIDENT_FROM_PROBLEM, {
    onCompleted: () => { toast.success('Incident scollegato'); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [linkChange] = useMutation(LINK_CHANGE_TO_PROBLEM, {
    onCompleted: () => { toast.success('Change collegata'); setChangeSearch(''); setShowChangeSearch(false); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const [addComment, { loading: addingComment }] = useMutation(ADD_PROBLEM_COMMENT, {
    onCompleted: () => { toast.success('Commento aggiunto'); setCommentText(''); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const problem         = data?.problem
  const users           = usersData?.users ?? []
  const teams           = teamsData?.teams ?? []
  const ciRules         = ciRulesData?.itilCIRelationRules ?? []
  const ciResults       = ciSearchData?.allCIs?.items ?? []
  const incidentResults = incidentSearchData?.incidents?.items ?? []
  const changeResults   = changeSearchData?.changes?.items   ?? []

  function handleTransitionClick(tr: WorkflowTransition) {
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
        <button onClick={() => navigate('/problems')} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
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
        <WatcherBar entityType="problem" entityId={problem.id} />
      </div>

      {/* Body grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left column */}
        <div>

          {/* Descrizione */}
          <SectionCard title={t('detail.sections.description')} defaultOpen>
            {problem.description ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>{problem.description}</p>
            ) : (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: 0 }}>{t('detail.noDescription')}</p>
            )}
          </SectionCard>

          {/* Root Cause */}
          <SectionCard title="Root Cause" defaultOpen>
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
          <SectionCard title="Workaround" defaultOpen>
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

          <ProblemCIList
            problemId={problem.id}
            affectedCIs={problem.affectedCIs}
            ciOpen={ciOpen}
            showCISearch={showCISearch}
            ciSearch={ciSearch}
            ciResults={ciResults}
            rules={ciRules}
            onToggle={() => setCiOpen((p) => !p)}
            onToggleSearch={(e) => { e.stopPropagation(); setShowCISearch((s) => !s); if (!ciOpen) setCiOpen(true) }}
            onSearchChange={setCiSearch}
            onAddCI={(ciId, relationType) => void addCI({ variables: { problemId: problem.id, ciId, relationType } })}
            onRemoveCI={(ciId) => void removeCI({ variables: { problemId: problem.id, ciId } })}
          />

          <ProblemIncidentList
            problemId={problem.id}
            relatedIncidents={problem.relatedIncidents}
            incidentsOpen={incidentsOpen}
            showIncidentSearch={showIncidentSearch}
            incidentSearch={incidentSearch}
            incidentResults={incidentResults}
            onToggle={() => setIncidentsOpen((p) => !p)}
            onToggleSearch={(e) => { e.stopPropagation(); setShowIncidentSearch((s) => !s); if (!incidentsOpen) setIncidentsOpen(true) }}
            onSearchChange={setIncidentSearch}
            onLink={(incidentId) => void linkIncident({ variables: { problemId: problem.id, incidentId } })}
            onUnlink={(incidentId) => void unlinkIncident({ variables: { problemId: problem.id, incidentId } })}
          />

          <ProblemChangeList
            problemId={problem.id}
            relatedChanges={problem.relatedChanges}
            changesOpen={changesOpen}
            showChangeSearch={showChangeSearch}
            changeSearch={changeSearch}
            changeResults={changeResults}
            onToggle={() => setChangesOpen((p) => !p)}
            onToggleSearch={(e) => { e.stopPropagation(); setShowChangeSearch((s) => !s); if (!changesOpen) setChangesOpen(true) }}
            onSearchChange={setChangeSearch}
            onLink={(changeId) => void linkChange({ variables: { problemId: problem.id, changeId } })}
          />

          <ProblemTimeline
            historyDesc={historyDesc}
            timelineOpen={timelineOpen}
            onToggle={() => setTimelineOpen((p) => !p)}
          />

          {/* Allegati */}
          <AttachmentsSection entityType="problem" entityId={problem.id} />

          {/* Commenti */}
          <SectionCard title={t('detail.sections.comments')} count={problem.comments.length} defaultOpen>
            <div>
                {problem.comments.length === 0 ? (
                  <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: '0 0 16px 0' }}>{t('detail.noCommentsYet')}</p>
                ) : (
                  <div style={{ marginBottom: 16 }}>
                    {problem.comments.slice().reverse().map((c, i) => (
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
                        {i < problem.comments.length - 1 && <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />}
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
                      onClick={() => void addComment({ variables: { problemId: problem.id, text: commentText.trim() } })}
                      style={{ padding: '7px 16px', backgroundColor: (commentText.trim() && !addingComment) ? 'var(--accent)' : 'var(--surface-2)', color: (commentText.trim() && !addingComment) ? '#fff' : 'var(--text-muted)', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: (commentText.trim() && !addingComment) ? 'pointer' : 'not-allowed' }}
                    >
                      {addingComment ? t('detail.sending') : t('detail.sendComment')}
                    </button>
                  </div>
                </div>
            </div>
          </SectionCard>

          <InternalChatPanel
            entityType="problem"
            entityId={problem.id}
            currentUserId={keycloak.subject ?? ''}
          />
        </div>

        {/* Right column */}
        <div>

          {/* Dettagli */}
          <Card style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)', margin: '0 0 16px 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('detail.sections.details')}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                    <button onClick={() => setShowReassign(true)} style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, fontSize: 'var(--font-size-body)', color: 'var(--accent)', cursor: 'pointer' }}>{t('detail.reassign')}</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Select value={selectedTeamId} onChange={(e) => setSelectedTeamId(e.target.value)} style={{ padding: '7px 10px', border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)', background: 'var(--surface)' }}>
                      <option value="">{t('detail.selectTeam')}</option>
                      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </Select>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {showReassign && (
                        <button onClick={() => setShowReassign(false)} style={{ flex: 1, padding: '6px 0', background: 'none', border: '1px solid var(--border)', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', cursor: 'pointer' }}>{t('common.cancel')}</button>
                      )}
                      <button disabled={!selectedTeamId || assigningTeam} onClick={() => { if (!selectedTeamId) return; void assignToTeam({ variables: { problemId: problem.id, teamId: selectedTeamId } }) }} style={{ flex: 1, padding: '6px 0', backgroundColor: (!selectedTeamId || assigningTeam) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedTeamId || assigningTeam) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: (!selectedTeamId || assigningTeam) ? 'not-allowed' : 'pointer' }}>
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
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} style={{ padding: '7px 10px', border: '1px solid var(--border)', fontSize: 'var(--font-size-card-title)', background: 'var(--surface)' }}>
                      <option value="">{t('detail.selectUser')}</option>
                      {(problem.assignedTeam ? users.filter((u) => u.teams?.some((t) => t.id === problem.assignedTeam!.id)) : users).map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </Select>
                    <button disabled={!selectedUserId || assigningUser} onClick={() => { if (!selectedUserId) return; void assignToUser({ variables: { problemId: problem.id, userId: selectedUserId } }) }} style={{ padding: '6px 0', backgroundColor: (!selectedUserId || assigningUser) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedUserId || assigningUser) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: (!selectedUserId || assigningUser) ? 'not-allowed' : 'pointer' }}>
                      {assigningUser ? t('detail.assigning') : t('detail.assign')}
                    </button>
                  </div>
                )
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
          </Card>

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
                onClick={() => {
                  if (transitionNotes.trim().length < 10) { toast.error('Note troppo brevi (minimo 10 caratteri)'); return }
                  void execTransition({ variables: { problemId: problem.id, toStep: pendingTransition.toStep, notes: transitionNotes.trim() } })
                }}
                style={{ padding: '8px 16px', borderRadius: 8, fontSize: 'var(--font-size-card-title)', fontWeight: 500, backgroundColor: transitionNotes.trim().length >= 10 ? 'var(--accent)' : 'var(--surface-2)', color: transitionNotes.trim().length >= 10 ? '#fff' : 'var(--text-muted)' }}
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
            autoFocus
            style={{ resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)' }}
          />
        </Modal>
      )}
    </PageContainer>
  )
}
