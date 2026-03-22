import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { ArrowLeft, X, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { CountBadge } from '@/components/ui/CountBadge'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { GET_PROBLEM, GET_USERS, GET_TEAMS, GET_ALL_CIS, GET_INCIDENTS, GET_CHANGES } from '@/graphql/queries'
import { ciPath } from '@/lib/ciPath'
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByField<T>(items: T[], key: keyof T): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const k = String(item[key])
    ;(acc[k] ??= []).push(item)
    return acc
  }, {})
}

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

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function timeAgo(s: string): string {
  const diff = Date.now() - new Date(s).getTime()
  const sec  = Math.floor(diff / 1000)
  if (sec < 60)          return 'adesso'
  const min = Math.floor(sec / 60)
  if (min < 60)          return `${min} min fa`
  const hrs = Math.floor(min / 60)
  if (hrs < 24)          return `${hrs} ore fa`
  const days = Math.floor(hrs / 24)
  if (days < 7)          return `${days} giorni fa`
  return formatDate(s)
}

function formatDuration(ms: number): string {
  if (ms < 60_000)     return '< 1 min'
  if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)} min`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} ore`
  return `${Math.floor(ms / 86_400_000)} giorni`
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: '#dc2626', high: '#0284c7', medium: '#ca8a04', low: '#16a34a',
}

const STATUS_BG: Record<string, string> = {
  new: '#ecfeff', under_investigation: '#ecfeff', change_requested: '#ecfeff',
  change_in_progress: '#ecfeff', resolved: '#ecfeff', closed: '#ecfeff',
  rejected: '#ecfeff', deferred: '#ecfeff',
}

const STATUS_FG: Record<string, string> = {
  new: '#0284c7', under_investigation: '#0284c7', change_requested: '#0284c7',
  change_in_progress: '#0284c7', resolved: '#0284c7', closed: '#0284c7',
  rejected: '#0284c7', deferred: '#0284c7',
}

const STEP_DOT: Record<string, string> = {
  new: '#94a3b8', under_investigation: '#3b82f6', change_requested: '#7c3aed',
  change_in_progress: '#0284c7', resolved: '#059669', closed: '#94a3b8',
  rejected: '#dc2626', deferred: '#d97706',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '20px 24px', ...style }}>
      {children}
    </div>
  )
}

function MicroBadge({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, backgroundColor: color ?? 'var(--surface-2)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>
      {children}
    </span>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>{children}</div>
    </div>
  )
}

function transitionButtonStyle(toStep: string, disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, border: '1px solid transparent', transition: 'opacity 0.15s' }
  if (toStep === 'resolved') return { ...base, backgroundColor: '#059669', color: '#fff', borderColor: '#059669' }
  if (toStep === 'rejected') return { ...base, backgroundColor: '#dc2626', color: '#fff', borderColor: '#dc2626' }
  if (toStep === 'closed')   return { ...base, backgroundColor: 'transparent', color: 'var(--text-primary)', borderColor: 'var(--border)' }
  return { ...base, backgroundColor: 'transparent', color: 'var(--text-primary)', borderColor: 'var(--border)' }
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProblemDetailPage() {
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

  const [editRootCause,  setEditRootCause]  = useState<string | null>(null)
  const [editWorkaround, setEditWorkaround] = useState<string | null>(null)
  const [editAffectedUsers, setEditAffectedUsers] = useState<string | null>(null)

  const [descOpen,       setDescOpen]       = useState(true)
  const [rootCauseOpen,  setRootCauseOpen]  = useState(true)
  const [workaroundOpen, setWorkaroundOpen] = useState(true)
  const [ciOpen,         setCiOpen]         = useState(true)
  const [incidentsOpen,  setIncidentsOpen]  = useState(true)
  const [changesOpen,    setChangesOpen]    = useState(true)
  const [timelineOpen,   setTimelineOpen]   = useState(true)
  const [commentsOpen,   setCommentsOpen]   = useState(true)

  const { data, loading, refetch } = useQuery<{ problem: Problem | null }>(GET_PROBLEM, { variables: { id }, skip: !id })
  const { data: usersData }        = useQuery<{ users: User[] }>(GET_USERS)
  const { data: teamsData }        = useQuery<{ teams: Team[] }>(GET_TEAMS)

  const { data: ciSearchData } = useQuery<{ allCIs: { items: CIRef[] } }>(GET_ALL_CIS, {
    variables: { search: ciSearch, limit: 20 },
    skip: ciSearch.length < 2,
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

  const problem      = data?.problem
  const users        = usersData?.users ?? []
  const teams        = teamsData?.teams ?? []
  const ciResults    = ciSearchData?.allCIs?.items ?? []
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

  if (!problem) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 14 }}>
        Problem non trovato.{' '}
        <button onClick={() => navigate('/problems')} style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 }}>
          Torna alla lista
        </button>
      </div>
    )
  }

  const manualTransitions = problem.availableTransitions
  const historyDesc       = [...problem.workflowHistory].reverse()

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <button onClick={() => navigate(-1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0 }}>
          <ArrowLeft size={14} />
          Indietro
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>{problem.title}</h1>
          <span style={{ padding: '2px 8px', borderRadius: 4, backgroundColor: PRIORITY_COLOR[problem.priority] ? `${PRIORITY_COLOR[problem.priority]}22` : '#f3f4f6', color: PRIORITY_COLOR[problem.priority] ?? '#64748b', fontSize: 12, fontWeight: 600, border: `1px solid ${PRIORITY_COLOR[problem.priority] ?? '#e5e7eb'}` }}>
            {problem.priority}
          </span>
          <span style={{ padding: '2px 8px', borderRadius: 4, backgroundColor: STATUS_BG[problem.status] ?? '#f3f4f6', color: STATUS_FG[problem.status] ?? '#64748b', fontSize: 12, fontWeight: 500 }}>
            {problem.status.replace(/_/g, ' ')}
          </span>
        </div>
        <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--text-muted)' }}>{problem.id}</div>
      </div>

      {/* Workflow action buttons */}
      {manualTransitions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
          {manualTransitions.map((tr) => (
            <button key={tr.toStep} onClick={() => handleTransitionClick(tr)} disabled={transitioning} style={transitionButtonStyle(tr.toStep, transitioning)}>
              {tr.label}
            </button>
          ))}
        </div>
      )}

      {/* Body grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24 }}>

        {/* Left column */}
        <div>

          {/* Descrizione */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setDescOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: descOpen ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Descrizione</span>
              {descOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
            </div>
            {descOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {problem.description ? (
                  <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>{problem.description}</p>
                ) : (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessuna descrizione.</p>
                )}
              </div>
            )}
          </Card>

          {/* Root Cause */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setRootCauseOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: rootCauseOpen ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Root Cause</span>
              {rootCauseOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
            </div>
            {rootCauseOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                <textarea
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
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, outline: 'none', resize: 'vertical', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", lineHeight: 1.6 }}
                />
              </div>
            )}
          </Card>

          {/* Workaround */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setWorkaroundOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: workaroundOpen ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Workaround</span>
              {workaroundOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
            </div>
            {workaroundOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                <textarea
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
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, outline: 'none', resize: 'vertical', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", lineHeight: 1.6 }}
                />
              </div>
            )}
          </Card>

          {/* CI Impattati */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setCiOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: ciOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>CI Impattati</span>
                <CountBadge count={problem.affectedCIs.length} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={(e) => { e.stopPropagation(); setShowCISearch((s) => !s); if (!ciOpen) setCiOpen(true) }} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}>
                  {showCISearch ? 'Chiudi' : '+ Aggiungi CI'}
                </button>
                {ciOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
              </div>
            </div>
            {ciOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {showCISearch && (
                  <div style={{ marginBottom: 12, position: 'relative' }}>
                    <input type="text" value={ciSearch} onChange={(e) => setCiSearch(e.target.value)} placeholder="Cerca CI (min. 2 caratteri)..." autoFocus style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }} />
                    {ciResults.length > 0 && (
                      <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto', backgroundColor: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                        {ciResults.filter((ci) => !problem.affectedCIs.find((a) => a.id === ci.id)).map((ci) => (
                          <div key={ci.id} onClick={() => void addCI({ variables: { problemId: problem.id, ciId: ci.id } })} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-2)' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}>
                            <span style={{ fontWeight: 500 }}>{ci.name}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{ci.type} · {ci.environment}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {problem.affectedCIs.length === 0 ? (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessun CI impattato registrato.</p>
                ) : (
                  <div>
                    {Object.entries(groupByField(problem.affectedCIs, 'type')).map(([type, cis]) => (
                      <CollapsibleGroup key={type} title={type.replace(/_/g, ' ')} count={cis.length}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {cis.map((ci) => (
                            <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0' }}>
                              <button onClick={() => navigate(ciPath(ci))} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{ci.name}</button>
                              <MicroBadge>{ci.status}</MicroBadge>
                              <MicroBadge>{ci.environment}</MicroBadge>
                              <button onClick={() => void removeCI({ variables: { problemId: problem.id, ciId: ci.id } })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: '0 2px', marginLeft: 'auto' }} title="Rimuovi CI"><X size={14} /></button>
                            </div>
                          ))}
                        </div>
                      </CollapsibleGroup>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Incident Correlati */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setIncidentsOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: incidentsOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Incident Correlati</span>
                <CountBadge count={problem.relatedIncidents.length} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={(e) => { e.stopPropagation(); setShowIncidentSearch((s) => !s); if (!incidentsOpen) setIncidentsOpen(true) }} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}>
                  {showIncidentSearch ? 'Chiudi' : '+ Collega Incident'}
                </button>
                {incidentsOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
              </div>
            </div>
            {incidentsOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {showIncidentSearch && (
                  <div style={{ marginBottom: 12 }}>
                    <input type="text" value={incidentSearch} onChange={(e) => setIncidentSearch(e.target.value)} placeholder="Filtra incident per titolo..." autoFocus style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }} />
                    {incidentResults.length > 0 && (
                      <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto', backgroundColor: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                        {incidentResults.filter((i) => !problem.relatedIncidents.find((r) => r.id === i.id) && (incidentSearch.length < 2 || i.title.toLowerCase().includes(incidentSearch.toLowerCase()))).map((inc) => (
                          <div key={inc.id} onClick={() => void linkIncident({ variables: { problemId: problem.id, incidentId: inc.id } })} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-2)' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}>
                            <span style={{ fontWeight: 500 }}>{inc.title}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{inc.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {problem.relatedIncidents.length === 0 ? (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessun incident correlato.</p>
                ) : (
                  <div>
                    {Object.entries(groupByField(problem.relatedIncidents, 'status')).map(([status, incidents]) => (
                      <CollapsibleGroup key={status} title={status.replace(/_/g, ' ')} count={incidents.length}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {incidents.map((inc) => (
                            <div key={inc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                              <button onClick={() => navigate(`/incidents/${inc.id}`)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{inc.title}</button>
                              <MicroBadge>{inc.severity}</MicroBadge>
                              <button onClick={() => void unlinkIncident({ variables: { problemId: problem.id, incidentId: inc.id } })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', marginLeft: 'auto' }} title="Scollega"><X size={14} /></button>
                            </div>
                          ))}
                        </div>
                      </CollapsibleGroup>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Change Correlate */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setChangesOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: changesOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Change Correlate</span>
                <CountBadge count={problem.relatedChanges.length} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={(e) => { e.stopPropagation(); setShowChangeSearch((s) => !s); if (!changesOpen) setChangesOpen(true) }} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--accent)' }}>
                  {showChangeSearch ? 'Chiudi' : '+ Collega Change'}
                </button>
                {changesOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
              </div>
            </div>
            {changesOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {showChangeSearch && (
                  <div style={{ marginBottom: 12 }}>
                    <input type="text" value={changeSearch} onChange={(e) => setChangeSearch(e.target.value)} placeholder="Cerca change (min. 2 caratteri)..." autoFocus style={{ width: '100%', boxSizing: 'border-box', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }} />
                    {changeResults.length > 0 && (
                      <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto', backgroundColor: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                        {changeResults.filter((c) => !problem.relatedChanges.find((r) => r.id === c.id)).map((ch) => (
                          <div key={ch.id} onClick={() => void linkChange({ variables: { problemId: problem.id, changeId: ch.id } })} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--surface-2)' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}>
                            <span style={{ fontWeight: 500 }}>{ch.title}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{ch.type} · {ch.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {problem.relatedChanges.length === 0 ? (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessuna change correlata.</p>
                ) : (
                  <div>
                    {Object.entries(groupByField(problem.relatedChanges, 'type')).map(([type, changes]) => (
                      <CollapsibleGroup key={type} title={type.replace(/_/g, ' ')} count={changes.length}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {changes.map((ch) => (
                            <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                              <button onClick={() => navigate(`/changes/${ch.id}`)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{ch.title}</button>
                              <MicroBadge>{ch.status}</MicroBadge>
                            </div>
                          ))}
                        </div>
                      </CollapsibleGroup>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Timeline */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setTimelineOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: timelineOpen ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Timeline workflow</span>
              {timelineOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
            </div>
            {timelineOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {historyDesc.length === 0 ? (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0 }}>Nessuna storia workflow.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {historyDesc.map((exec, idx) => {
                      const isCurrent = idx === 0
                      return (
                      <div key={exec.id} style={{ display: 'flex', gap: 12, paddingBottom: idx < historyDesc.length - 1 ? 16 : 0, position: 'relative' }}>
                        {idx < historyDesc.length - 1 && (
                          <div style={{ position: 'absolute', left: 7, top: 18, bottom: 0, width: 2, backgroundColor: '#64748b', opacity: 0.3 }} />
                        )}
                        <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: isCurrent ? '#0284c7' : '#64748b', flexShrink: 0, marginTop: 2, border: '2px solid #fff', boxShadow: isCurrent ? '0 0 0 3px rgba(2,132,199,0.2)' : '0 0 0 1px rgba(100,116,139,0.3)' }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a' }}>{exec.stepName.replace(/_/g, ' ')}</div>
                          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 6 }}>
                            <span>{timeAgo(exec.enteredAt)}</span>
                            {exec.durationMs != null && <span>({formatDuration(exec.durationMs)})</span>}
                          </div>
                          {exec.notes && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, fontStyle: 'italic' }}>{exec.notes}</div>}
                        </div>
                      </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Commenti */}
          <Card style={{ marginBottom: 16, padding: 0 }}>
            <div onClick={() => setCommentsOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: commentsOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>Commenti</span>
                <CountBadge count={problem.comments.length} />
              </div>
              {commentsOpen ? <ChevronDown size={16} color="#94a3b8" /> : <ChevronRight size={16} color="#94a3b8" />}
            </div>
            {commentsOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                {problem.comments.length === 0 ? (
                  <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 16px 0' }}>Nessun commento ancora.</p>
                ) : (
                  <div style={{ marginBottom: 16 }}>
                    {problem.comments.slice().reverse().map((c, i) => (
                      <div key={c.id}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0' }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', backgroundColor: '#ecfeff', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
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
                        {i < problem.comments.length - 1 && <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: 0 }} />}
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
                      onClick={() => void addComment({ variables: { problemId: problem.id, text: commentText.trim() } })}
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

          {/* Dettagli */}
          <Card style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: '0 0 16px 0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Dettagli</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <DetailRow label="Priorità">
                <span style={{ fontWeight: 600, color: PRIORITY_COLOR[problem.priority] ?? '#64748b' }}>{problem.priority}</span>
              </DetailRow>
              <DetailRow label="Step workflow">
                <span style={{ padding: '2px 8px', borderRadius: 4, backgroundColor: STATUS_BG[problem.status] ?? '#f3f4f6', color: STATUS_FG[problem.status] ?? '#64748b', fontSize: 12, fontWeight: 500 }}>
                  {problem.workflowInstance?.currentStep.replace(/_/g, ' ') ?? problem.status.replace(/_/g, ' ')}
                </span>
              </DetailRow>

              {/* Team assignment */}
              <DetailRow label="Team assegnato">
                {problem.assignedTeam && !showReassign ? (
                  <div>
                    <div style={{ fontWeight: 500 }}>{problem.assignedTeam.name}</div>
                    <button onClick={() => setShowReassign(true)} style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>Riassegna</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <select value={selectedTeamId} onChange={(e) => setSelectedTeamId(e.target.value)} style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, backgroundColor: 'var(--surface)', outline: 'none' }}>
                      <option value="">Seleziona team…</option>
                      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {showReassign && (
                        <button onClick={() => setShowReassign(false)} style={{ flex: 1, padding: '6px 0', background: 'none', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Annulla</button>
                      )}
                      <button disabled={!selectedTeamId || assigningTeam} onClick={() => { if (!selectedTeamId) return; void assignToTeam({ variables: { problemId: problem.id, teamId: selectedTeamId } }) }} style={{ flex: 1, padding: '6px 0', backgroundColor: (!selectedTeamId || assigningTeam) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedTeamId || assigningTeam) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: (!selectedTeamId || assigningTeam) ? 'not-allowed' : 'pointer' }}>
                        {assigningTeam ? 'Assegnazione…' : 'Assegna'}
                      </button>
                    </div>
                  </div>
                )}
              </DetailRow>

              {/* User assignment */}
              <DetailRow label="Assegnato a">
                {problem.assignee ? (
                  <div>
                    <div style={{ fontWeight: 500 }}>{problem.assignee.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{problem.assignee.email}</div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, backgroundColor: 'var(--surface)', outline: 'none' }}>
                      <option value="">Seleziona utente…</option>
                      {(problem.assignedTeam ? users.filter((u) => u.teams?.some((t) => t.id === problem.assignedTeam!.id)) : users).map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                    <button disabled={!selectedUserId || assigningUser} onClick={() => { if (!selectedUserId) return; void assignToUser({ variables: { problemId: problem.id, userId: selectedUserId } }) }} style={{ padding: '6px 0', backgroundColor: (!selectedUserId || assigningUser) ? 'var(--surface-2)' : 'var(--accent)', color: (!selectedUserId || assigningUser) ? 'var(--text-muted)' : '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: (!selectedUserId || assigningUser) ? 'not-allowed' : 'pointer' }}>
                      {assigningUser ? 'Assegnazione…' : 'Assegna'}
                    </button>
                  </div>
                )}
              </DetailRow>

              {/* Affected users */}
              <DetailRow label="Utenti impattati">
                <input
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
                  style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, outline: 'none' }}
                />
              </DetailRow>

              {problem.createdBy && (
                <DetailRow label="Creato da">
                  <span style={{ fontWeight: 500 }}>{problem.createdBy.name}</span>
                </DetailRow>
              )}
              <DetailRow label="Creato il">{formatDate(problem.createdAt)}</DetailRow>
              {problem.updatedAt && <DetailRow label="Aggiornato">{timeAgo(problem.updatedAt)}</DetailRow>}
              {problem.resolvedAt && <DetailRow label="Risolto il">{formatDate(problem.resolvedAt)}</DetailRow>}
            </div>
          </Card>

        </div>
      </div>

      {/* Transition Dialog */}
      {isTransitionDialogOpen && pendingTransition && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ backgroundColor: '#fff', borderRadius: 10, padding: 28, width: 480, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', margin: '0 0 12px 0' }}>
              {`Transizione → ${pendingTransition.toStep.replace(/_/g, ' ')}`}
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16, marginTop: 0 }}>
              Aggiungi una nota per questa transizione (minimo 10 caratteri).
            </p>
            <textarea
              value={transitionNotes}
              onChange={(e) => setTransitionNotes(e.target.value)}
              placeholder="Note sulla transizione..."
              rows={4}
              autoFocus
              style={{ width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, lineHeight: 1.6, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => { setIsTransitionDialogOpen(false); setTransitionNotes('') }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 14, fontWeight: 500 }}>
                Annulla
              </button>
              <button
                onClick={() => {
                  if (transitionNotes.trim().length < 10) { toast.error('Note troppo brevi (minimo 10 caratteri)'); return }
                  void execTransition({ variables: { problemId: problem.id, toStep: pendingTransition.toStep, notes: transitionNotes.trim() } })
                }}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500, backgroundColor: transitionNotes.trim().length >= 10 ? 'var(--accent)' : 'var(--surface-2)', color: transitionNotes.trim().length >= 10 ? '#fff' : 'var(--text-muted)' }}
              >
                {transitioning ? 'Esecuzione...' : 'Conferma'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
