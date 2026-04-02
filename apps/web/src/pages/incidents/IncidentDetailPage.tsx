import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Modal } from '@/components/Modal'
import { CountBadge } from '@/components/ui/CountBadge'
import { SeverityBadge } from '@/components/SeverityBadge'
import { GET_INCIDENT, GET_USERS, GET_TEAMS, GET_ALL_CIS } from '@/graphql/queries'
import { EXECUTE_WORKFLOW_TRANSITION, ASSIGN_INCIDENT_TO_TEAM, ASSIGN_INCIDENT_TO_USER, ADD_INCIDENT_COMMENT, ADD_AFFECTED_CI, REMOVE_AFFECTED_CI } from '@/graphql/mutations'
import { IncidentHeader } from './IncidentHeader'
import { IncidentTimeline } from './IncidentTimeline'
import { IncidentCIList } from './IncidentCIList'

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
}

interface Comment {
  id:        string
  text:      string
  createdAt: string
  updatedAt: string
  author:    { id: string; name: string; email: string } | null
}

interface User { id: string; name: string; email: string; teams: { id: string; name: string }[] }

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function timeAgo(s: string): string {
  const diff = Date.now() - new Date(s).getTime()
  const sec  = Math.floor(diff / 1000)
  if (sec < 60)             return 'adesso'
  const min = Math.floor(sec / 60)
  if (min < 60)             return `${min} min fa`
  const hrs = Math.floor(min / 60)
  if (hrs < 24)             return `${hrs} ore fa`
  const days = Math.floor(hrs / 24)
  if (days < 7)             return `${days} giorni fa`
  return formatDate(s)
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      backgroundColor: '#fff',
      border:          '1px solid #e5e7eb',
      borderRadius:    10,
      boxShadow:       '0 1px 2px rgba(0,0,0,0.05)',
      padding:         '20px 24px',
      ...style,
    }}>
      {children}
    </div>
  )
}


function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>{children}</div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function IncidentDetailPage() {
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

  const [ciSearch,      setCiSearch]      = useState('')
  const [showCISearch,  setShowCISearch]  = useState(false)

  const [descOpen,     setDescOpen]     = useState(true)
  const [detailsOpen,  setDetailsOpen]  = useState(true)
  const [ciOpen,       setCiOpen]       = useState(true)
  const [commentsOpen, setCommentsOpen] = useState(true)
  const [timelineOpen, setTimelineOpen] = useState(true)

  const { data, loading, refetch } = useQuery<{ incident: Incident | null }>(
    GET_INCIDENT,
    { variables: { id }, skip: !id },
  )
  const { data: usersData } = useQuery<{ users: User[] }>(GET_USERS)
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS)
  const { data: ciSearchData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20 },
    skip: ciSearch.length < 2,
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

  const [removeCI] = useMutation(REMOVE_AFFECTED_CI, {
    onCompleted: () => { toast.success('CI rimosso'); void refetch() },
    onError: (err) => toast.error(err.message),
  })

  const incident  = data?.incident
  const users     = usersData?.users ?? []
  const teams     = teamsData?.teams ?? []
  const ciResults = ciSearchData?.allCIs?.items ?? []

  function handleTransitionClick(tr: WorkflowTransition) {
    if (tr.toStep === 'assigned' && !incident?.assignedTeam) {
      toast.error('Seleziona prima un team dalla card Dettagli')
      return
    }
    if (tr.toStep === 'in_progress' && !incident?.assignee) {
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

  if (!incident) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 14 }}>
        Incident non trovato.{' '}
        <button
          onClick={() => navigate('/incidents')}
          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 }}
        >
          Torna alla lista
        </button>
      </div>
    )
  }

  const manualTransitions = incident.availableTransitions.filter((t) => t.toStep !== undefined)
  const historyDesc       = [...incident.workflowHistory].reverse()

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>

      {/* Header + action buttons */}
      <IncidentHeader
        incident={incident}
        manualTransitions={manualTransitions}
        transitioning={transitioning}
        onBack={() => navigate(-1)}
        onTransitionClick={handleTransitionClick}
      />

      {/* Body grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left column */}
        <div>

          {/* Descrizione */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setDescOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: descOpen ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Descrizione</span>
              {descOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
            </div>
            {descOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {incident.description ? (
                  <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>{incident.description}</p>
                ) : (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessuna descrizione.</p>
                )}
              </div>
            )}
          </Card>

          {/* Dettagli */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setDetailsOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: detailsOpen ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Dettagli</span>
              {detailsOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
            </div>
            {detailsOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 12px', marginBottom: 16 }}>
                  <DetailRow label="Severity">
                    <SeverityBadge value={incident.severity} />
                  </DetailRow>
                  <DetailRow label="Step workflow">
                    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, backgroundColor: 'var(--color-brand-light)', color: 'var(--color-brand)', fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>
                      {incident.workflowInstance?.currentStep.replace(/_/g, ' ') ?? 'N/D'}
                    </span>
                  </DetailRow>
                  <DetailRow label="Assegnato a">
                    {incident.assignee ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>{incident.assignee.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{incident.assignee.email}</div>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>Non assegnato</span>
                    )}
                  </DetailRow>
                  <DetailRow label="Aperto il">{formatDate(incident.createdAt)}</DetailRow>
                  <DetailRow label="Aggiornato">{timeAgo(incident.updatedAt)}</DetailRow>
                  {incident.resolvedAt && (
                    <DetailRow label="Risolto il">{formatDate(incident.resolvedAt)}</DetailRow>
                  )}
                  {incident.rootCause && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <DetailRow label="Root Cause">
                        <span style={{ fontSize: 12, lineHeight: 1.5 }}>{incident.rootCause}</span>
                      </DetailRow>
                    </div>
                  )}
                </div>

                {/* Assegnazione a due step */}
                {incident.status !== 'closed' && (() => {
                  const hasTeam = !!incident.assignedTeam
                  const hasUser = !!incident.assignee && !awaitingUserAssign

                  if (hasTeam && hasUser && !showReassign) {
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          Team: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{incident.assignedTeam!.name}</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          Assegnato: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{incident.assignee!.name}</span>
                        </div>
                        <button
                          onClick={() => { setShowReassign(true); setAwaitingUserAssign(false) }}
                          style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, fontSize: 12, color: 'var(--accent)', cursor: 'pointer', textAlign: 'left' }}
                        >
                          Riassegna
                        </button>
                      </div>
                    )
                  }

                  if (!hasTeam || showReassign) {
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>Team</label>
                        <select
                          value={selectedTeamId}
                          onChange={(e) => setSelectedTeamId(e.target.value)}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, color: 'var(--text-primary)', backgroundColor: 'var(--surface)', outline: 'none' }}
                        >
                          <option value="">Seleziona team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {showReassign && (
                            <button onClick={() => setShowReassign(false)} style={{ flex: 1, padding: '7px 0', background: 'none', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                              Annulla
                            </button>
                          )}
                          <button
                            disabled={!selectedTeamId || !selectedTeamId.trim() || assigningTeam}
                            onClick={() => {
                              if (!selectedTeamId) return
                              void assignToTeam({ variables: { id: incident.id, teamId: selectedTeamId } })
                              setShowReassign(false)
                            }}
                            style={{ flex: 1, padding: '7px 0', backgroundColor: (!selectedTeamId || assigningTeam) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedTeamId || assigningTeam) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: (!selectedTeamId || assigningTeam) ? 'not-allowed' : 'pointer' }}
                          >
                            {assigningTeam ? 'Assegnazione…' : 'Assegna team'}
                          </button>
                        </div>
                      </div>
                    )
                  }

                  const teamUsers = users.filter((u) => u.teams?.some((t) => t.id === incident.assignedTeam?.id))
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Team: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{incident.assignedTeam!.name}</span>
                      </div>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>Assegnato a</label>
                      <select
                        value={selectedUserId}
                        onChange={(e) => setSelectedUserId(e.target.value)}
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, color: 'var(--text-primary)', backgroundColor: 'var(--surface)', outline: 'none' }}
                      >
                        <option value="">Seleziona utente…</option>
                        {teamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      <button
                        disabled={!selectedUserId || !selectedUserId.trim() || assigningUser}
                        onClick={() => {
                          if (!selectedUserId) return
                          void assignToUser({ variables: { id: incident.id, userId: selectedUserId } })
                        }}
                        style={{ padding: '7px 0', backgroundColor: (!selectedUserId || assigningUser) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedUserId || assigningUser) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: (!selectedUserId || assigningUser) ? 'not-allowed' : 'pointer' }}
                      >
                        {assigningUser ? 'Assegnazione…' : 'Prendi in carico'}
                      </button>
                    </div>
                  )
                })()}
              </div>
            )}
          </Card>

          {/* CI Impattati */}
          <IncidentCIList
            incidentId={incident.id}
            affectedCIs={incident.affectedCIs}
            ciOpen={ciOpen}
            showCISearch={showCISearch}
            ciSearch={ciSearch}
            ciResults={ciResults}
            onToggle={() => setCiOpen((p) => !p)}
            onToggleSearch={(e) => { e.stopPropagation(); setShowCISearch((s) => !s); if (!ciOpen) setCiOpen(true) }}
            onSearchChange={setCiSearch}
            onAddCI={(ciId) => void addCI({ variables: { incidentId: incident.id, ciId } })}
            onRemoveCI={(ciId) => void removeCI({ variables: { incidentId: incident.id, ciId } })}
          />

          {/* Commenti */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setCommentsOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: commentsOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Commenti</span>
                <CountBadge count={incident.comments.length} />
              </div>
              {commentsOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
            </div>
            {commentsOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {incident.comments.length === 0 ? (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 16px 0' }}>Nessun commento ancora.</p>
                ) : (
                  <div style={{ marginBottom: 16 }}>
                    {incident.comments.slice().reverse().map((c, i) => (
                      <div key={c.id}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0' }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', backgroundColor: 'var(--color-brand-light)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                            {c.author ? c.author.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '?'}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 }}>
                              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{c.author?.name ?? 'Utente sconosciuto'}</span>
                              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{timeAgo(c.createdAt)}</span>
                            </div>
                            <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>{c.text}</p>
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
                  <Label style={{ fontSize: 12 }}>Scrivi un commento</Label>
                  <Textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Scrivi un commento..." rows={3} />
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      disabled={!commentText.trim() || addingComment}
                      onClick={() => void addComment({ variables: { id: incident.id, text: commentText.trim() } })}
                      style={{ padding: '7px 16px', backgroundColor: (commentText.trim() && !addingComment) ? 'var(--accent)' : 'var(--surface-2)', color: (commentText.trim() && !addingComment) ? '#fff' : 'var(--text-muted)', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: (commentText.trim() && !addingComment) ? 'pointer' : 'not-allowed' }}
                    >
                      {addingComment ? 'Invio…' : 'Invia commento'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Card>
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
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 14, fontWeight: 500 }}
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
              style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500, backgroundColor: transitionNotes.trim().length >= 10 ? 'var(--accent)' : 'var(--surface-2)', color: transitionNotes.trim().length >= 10 ? '#fff' : 'var(--text-muted)' }}
            >
              {transitioning ? 'Esecuzione...' : 'Conferma'}
            </button>
          </>
        }
      >
        {pendingTransition && (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16, marginTop: 0 }}>
              {pendingTransition.inputField === 'rootCause'
                ? 'Descrivi la causa radice prima di risolvere (minimo 10 caratteri).'
                : 'Aggiungi una nota per questa transizione (minimo 10 caratteri).'}
            </p>
            <textarea
              value={transitionNotes}
              onChange={(e) => { setTransitionNotes(e.target.value); setNotesError('') }}
              placeholder={pendingTransition.inputField === 'rootCause' ? 'Es: Memory leak in payment-service v2.3.1...' : 'Note sulla transizione...'}
              rows={4}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, lineHeight: 1.6, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", outline: 'none' }}
              autoFocus
            />
            {notesError && (
              <p style={{ fontSize: 12, color: 'var(--color-trigger-sla-breach)', margin: '6px 0 0 0' }}>{notesError}</p>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
