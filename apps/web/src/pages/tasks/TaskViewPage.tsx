import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Plus, X, ChevronRight, Bell, RotateCcw } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { SectionCard } from '@/components/ui/SectionCard'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { styleForCategory } from '@/lib/workflowStepStyle'
import {
  GET_TASK_BY_ID,
  GET_CHANGE,
  GET_CHANGE_AFFECTED_CIS,
  GET_QUESTION_CATALOG,
  GET_ME,
  GET_USERS,
  GET_TEAM_DETAIL,
} from '@/graphql/queries'
import {
  SUBMIT_ASSESSMENT_RESPONSE,
  COMPLETE_ASSESSMENT_TASK,
  ASSIGN_ASSESSMENT_TASK_TO_USER,
  SAVE_DEPLOY_PLAN,
  COMPLETE_DEPLOY_PLAN_TASK,
  COMPLETE_VALIDATION_TEST,
  COMPLETE_DEPLOYMENT,
  COMPLETE_REVIEW,
  SEND_TASK_REMINDER,
  REOPEN_TASK,
  REOPEN_DEPLOY_PLAN,
  REOPEN_VALIDATION,
  REOPEN_DEPLOYMENT,
  REOPEN_REVIEW,
} from '@/graphql/mutations'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaskDetail {
  id: string; code: string; kind: string
  changeId: string; changeCode: string; changeTitle: string; changePhase: string; changeDescription: string | null
  ciId: string; ciName: string; ciType: string | null; ciEnv: string | null
}

interface TimeWindow { start: string; end: string }
interface DeployStep { title: string; validationWindow: TimeWindow; releaseWindow: TimeWindow }
interface AnswerOption { id: string; label: string; score: number; sortOrder: number }
interface Question { id: string; text: string; category: string; options: AnswerOption[] }
interface CatalogEntry { weight: number; sortOrder: number; question: Question }
interface ResponseDetail { question: { id: string }; selectedOption: { id: string } }
interface AssessmentTask { id: string; responderRole: string; status: string; score: number | null; assignedTeam: { id: string; name: string } | null; assignee: { id: string; name: string } | null; responses: ResponseDetail[] }
interface DeployPlanTask { id: string; status: string; steps: DeployStep[]; assignedTeam: { id: string; name: string } | null; assignee: { id: string; name: string } | null }
interface AffectedCI {
  ciPhase: string; riskScore: number | null
  ci: { id: string; name: string; type: string | null; environment: string | null; ownerGroup: { id: string; name: string } | null; supportGroup: { id: string; name: string } | null }
  assessmentOwner: AssessmentTask | null; assessmentSupport: AssessmentTask | null
  deployPlan: DeployPlanTask | null
  validation: { id: string; status: string; result: string | null } | null
  deployment: { id: string; status: string } | null
  review: { id: string; status: string; result: string | null } | null
}
interface ChangeData { id: string; code: string; title: string; description: string | null; workflowInstance: { currentStep: string } | null; aggregateRiskScore: number | null; approvalRoute: string | null; requester: { name: string } | null; changeOwner: { name: string } | null }

// ── Helpers ───────────────────────────────────────────────────────────────────

type DotState = 'not_started' | 'in_progress' | 'completed' | 'failed'
const DOT_COLOR: Record<DotState, string> = { not_started: 'var(--color-slate-light)', in_progress: '#eab308', completed: '#22c55e', failed: '#ef4444' }

function assessDotState(t: AssessmentTask | null): DotState {
  if (!t) return 'not_started'
  if (t.status === 'completed') return 'completed'
  if (t.status === 'in-progress' || t.responses.length > 0) return 'in_progress'
  return 'not_started'
}
function planDotState(t: DeployPlanTask | null): DotState {
  if (!t) return 'not_started'
  if (t.status === 'completed') return 'completed'
  if (t.steps.length > 0) return 'in_progress'
  return 'not_started'
}
function simpleDotState(t: { status: string; result?: string | null } | null): DotState {
  if (!t) return 'not_started'
  if (t.status === 'completed') return (t.result === 'fail' || t.result === 'rejected') ? 'failed' : 'completed'
  if (t.status !== 'pending') return 'in_progress'
  return 'not_started'
}

function CIDots({ a }: { a: AffectedCI }) {
  const dots: Array<{ label: string; state: DotState }> = [
    { label: 'Functional',  state: assessDotState(a.assessmentOwner) },
    { label: 'Technical',   state: assessDotState(a.assessmentSupport) },
    { label: 'Piano',       state: planDotState(a.deployPlan) },
    { label: 'Validation',  state: simpleDotState(a.validation) },
    { label: 'Deploy',      state: simpleDotState(a.deployment) },
    { label: 'Review',      state: simpleDotState(a.review) },
  ]
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {dots.map((d, i) => (
        <span key={i} title={d.label} style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: DOT_COLOR[d.state], display: 'inline-block' }} />
      ))}
    </div>
  )
}

function PhaseBadge({ phase, label, category }: { phase: string; label?: string; category?: string | null }) {
  const s = styleForCategory(category)
  return <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>{label || phase}</span>
}

function RiskBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return null
  const p = score <= 30 ? { bg: '#dcfce7', color: '#15803d' } : score <= 60 ? { bg: '#fef3c7', color: '#b45309' } : { bg: '#fee2e2', color: '#b91c1c' }
  return <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: p.bg, color: p.color }}>{score}</span>
}

function toLocal(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocal(v: string): string { return v ? new Date(v).toISOString() : '' }

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 6,
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600,
  color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
}

const KIND_TITLE: Record<string, string> = {
  assessment: 'Assessment', 'deploy-plan': 'Piano di Deploy',
  validation: 'Validation', deployment: 'Deployment', review: 'Review',
}

// ── Task View Page ────────────────────────────────────────────────────────────

export function TaskViewPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  const id = taskId ?? ''

  const { data: taskData, loading: taskLoading } = useQuery<{ taskById: TaskDetail | null }>(GET_TASK_BY_ID, { variables: { id }, fetchPolicy: 'cache-and-network' })
  const task = taskData?.taskById

  const { data: changeData } = useQuery<{ change: ChangeData | null }>(GET_CHANGE, { variables: { id: task?.changeId ?? '' }, skip: !task, fetchPolicy: 'cache-and-network' })
  const { data: affectedData, refetch: refetchAffected } = useQuery<{ changeAffectedCIs: AffectedCI[] }>(GET_CHANGE_AFFECTED_CIS, { variables: { changeId: task?.changeId ?? '' }, skip: !task, fetchPolicy: 'cache-and-network' })
  const { data: funcCat } = useQuery<{ assessmentQuestionCatalog: CatalogEntry[] }>(GET_QUESTION_CATALOG, { variables: { category: 'functional' }, skip: !task || (task.kind !== 'assessment') })
  const { data: techCat } = useQuery<{ assessmentQuestionCatalog: CatalogEntry[] }>(GET_QUESTION_CATALOG, { variables: { category: 'technical' }, skip: !task || (task.kind !== 'assessment') })
  const { data: meData } = useQuery<{ me: { id: string; role: string; teams: { id: string }[] } | null }>(GET_ME, { fetchPolicy: 'cache-first' })
  const { data: usersData } = useQuery<{ users: Array<{ id: string; name: string; teams: { id: string }[] }> }>(GET_USERS, { variables: { sortField: 'name', sortDirection: 'asc' }, fetchPolicy: 'cache-first' })
  const { byName: changeStepByName } = useWorkflowSteps('change')

  const change = changeData?.change
  const allAffected = affectedData?.changeAffectedCIs ?? []
  const ciAffected = allAffected.find(a => a.ci.id === task?.ciId) ?? null
  const isAdmin = meData?.me?.role === 'admin'
  const userTeamIds = new Set((meData?.me?.teams ?? []).map(t => t.id))
  const currentUserId = meData?.me?.id ?? null

  // Team users for assignee select
  const getTeamUsers = (teamId: string | null | undefined): Array<{ id: string; name: string }> => {
    if (!teamId) return []
    return (usersData?.users ?? []).filter(u => u.teams.some(t => t.id === teamId)).map(u => ({ id: u.id, name: u.name }))
  }

  // Mutations
  const refetchAll = async () => { await refetchAffected() }
  const goToChange = () => { const cid = taskData?.taskById?.changeId; if (cid) { toast.success('Task completato'); navigate(`/changes/${cid}`) } }
  const [submitAnswer]     = useMutation(SUBMIT_ASSESSMENT_RESPONSE,   { onCompleted: refetchAll, onError: (e) => toast.error(e.message) })
  const [completeAssess]   = useMutation(COMPLETE_ASSESSMENT_TASK,     { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [assignUser]       = useMutation(ASSIGN_ASSESSMENT_TASK_TO_USER, { onCompleted: async () => { toast.success('Assegnazione aggiornata'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [savePlan]         = useMutation(SAVE_DEPLOY_PLAN,             { onCompleted: async () => { toast.success('Piano salvato'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [completePlan]     = useMutation(COMPLETE_DEPLOY_PLAN_TASK,    { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [completeVal]      = useMutation(COMPLETE_VALIDATION_TEST,     { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [completeDep]      = useMutation(COMPLETE_DEPLOYMENT,          { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [completeRev]      = useMutation(COMPLETE_REVIEW,              { onCompleted: goToChange, onError: (e) => toast.error(e.message) })

  // Reopen mutations (admin only)
  const reopenMutationMap: Record<string, ReturnType<typeof useMutation>[1]> = {}
  const [reopenAssess]     = useMutation(REOPEN_TASK,          { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenPlan]       = useMutation(REOPEN_DEPLOY_PLAN,   { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenVal]        = useMutation(REOPEN_VALIDATION,    { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenDep]        = useMutation(REOPEN_DEPLOYMENT,    { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenRev]        = useMutation(REOPEN_REVIEW,        { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  void reopenMutationMap // suppress

  const [showReopenModal, setShowReopenModal] = useState(false)

  const handleReopen = (reason: string) => {
    setShowReopenModal(false)
    const kind = task?.kind
    if (!kind) return
    if (kind === 'assessment') void reopenAssess({ variables: { taskId: id, reason } })
    else if (kind === 'deploy-plan') void reopenPlan({ variables: { taskId: id, reason } })
    else if (kind === 'validation') void reopenVal({ variables: { id, reason } })
    else if (kind === 'deployment') void reopenDep({ variables: { id, reason } })
    else if (kind === 'review') void reopenRev({ variables: { id, reason } })
  }

  if (taskLoading && !task) return <PageContainer><p>Caricamento...</p></PageContainer>
  if (!task) return <PageContainer><p>Task non trovato</p></PageContainer>

  // Determine which specific task object we're editing
  const assessTask = task.kind === 'assessment'
    ? (ciAffected?.assessmentOwner?.id === id ? ciAffected.assessmentOwner : ciAffected?.assessmentSupport?.id === id ? ciAffected.assessmentSupport : null)
    : null
  const planTask = task.kind === 'deploy-plan' ? ciAffected?.deployPlan : null

  const assessRole = assessTask?.responderRole ?? null
  const catalog = assessRole === 'owner' ? (funcCat?.assessmentQuestionCatalog ?? []) : assessRole === 'support' ? (techCat?.assessmentQuestionCatalog ?? []) : []

  // Gate: is user in the right team?
  const ciOwnerTeamId = ciAffected?.ci.ownerGroup?.id ?? null
  const ciSupportTeamId = ciAffected?.ci.supportGroup?.id ?? null
  const canEdit = isAdmin || (
    task.kind === 'assessment' ? (assessRole === 'owner' ? !!ciOwnerTeamId && userTeamIds.has(ciOwnerTeamId) : !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId))
    : task.kind === 'deploy-plan' ? !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId)
    : task.kind === 'validation' || task.kind === 'review' ? !!ciOwnerTeamId && userTeamIds.has(ciOwnerTeamId)
    : task.kind === 'deployment' ? !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId)
    : false
  )

  const taskTitle = KIND_TITLE[task.kind] ?? task.kind

  // Check if the specific task is completed
  const isTaskCompleted = (() => {
    if (task.kind === 'assessment') return assessTask?.status === 'completed'
    if (task.kind === 'deploy-plan') return planTask?.status === 'completed'
    if (task.kind === 'validation') return ciAffected?.validation?.status === 'completed'
    if (task.kind === 'deployment') return ciAffected?.deployment?.status === 'completed'
    if (task.kind === 'review') return ciAffected?.review?.status === 'completed'
    return false
  })()

  // Responsible team ID (for gate panel)
  const responsibleTeamId = (() => {
    if (task.kind === 'assessment') return assessRole === 'owner' ? ciOwnerTeamId : ciSupportTeamId
    if (task.kind === 'deploy-plan' || task.kind === 'deployment') return ciSupportTeamId
    return ciOwnerTeamId // validation, review
  })()

  // Approval route live
  const allScores = allAffected.filter(a => a.riskScore != null).map(a => a.riskScore!)
  const allAssessmentsDone = allAffected.length > 0 && allAffected.every(a => a.assessmentOwner?.status === 'completed' && a.assessmentSupport?.status === 'completed')
  const liveRoute = allScores.length === 0
    ? { label: 'Da calcolare', color: 'var(--color-slate-light)', bg: '#f1f5f9' }
    : (() => {
        const max = Math.max(...allScores)
        const route = max <= 30 ? 'Auto-approvato' : max <= 60 ? 'Change Manager' : 'CAB'
        const suffix = allAssessmentsDone ? '' : ' (stima)'
        const color = allAssessmentsDone
          ? (max <= 30 ? '#15803d' : max <= 60 ? '#b45309' : '#b91c1c')
          : 'var(--color-slate)'
        const bg = allAssessmentsDone
          ? (max <= 30 ? '#dcfce7' : max <= 60 ? '#fef3c7' : '#fee2e2')
          : '#f1f5f9'
        return { label: `${route}${suffix}`, color, bg }
      })()

  return (
    <PageContainer style={{ padding: '16px 24px' }}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
        <Link to={`/changes/${task.changeId}`} style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>{task.changeCode}</Link>
        <ChevronRight size={14} />
        <span style={{ color: 'var(--color-slate)' }}>{task.ciName}</span>
        <ChevronRight size={14} />
        <span style={{ color: 'var(--color-slate-dark)', fontWeight: 500 }}>{task.code}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 24, alignItems: 'start' }}>

        {/* ── LEFT: Task focused ── */}
        <div>
          {showReopenModal && <ReopenModal onConfirm={handleReopen} onCancel={() => setShowReopenModal(false)} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
              {task.code}
            </h1>
            {isAdmin && isTaskCompleted && (
              <button
                type="button"
                onClick={() => setShowReopenModal(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 6,
                  border: '1px solid #eab308', background: '#fefce8',
                  color: '#92400e', fontWeight: 600, cursor: 'pointer',
                  fontSize: 'var(--font-size-body)',
                }}
              >
                <RotateCcw size={14} /> Riapri task
              </button>
            )}
          </div>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 4px' }}>
            {taskTitle}
          </p>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 20px' }}>
            {task.ciName}{task.ciType ? ` · ${task.ciType}` : ''}
          </p>

          {/* Assignee select (for assessment/deploy-plan) */}
          {(task.kind === 'assessment' || task.kind === 'deploy-plan') && (() => {
            const t = task.kind === 'assessment' ? assessTask : planTask
            if (!t) return null
            const teamId = t.assignedTeam?.id ?? null
            const teamUsers = getTeamUsers(teamId)
            const canAssign = canEdit && t.status !== 'completed'
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>
                  Team: {t.assignedTeam?.name ?? '—'}
                </span>
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginLeft: 12 }}>Assegnato a</span>
                <select
                  disabled={!canAssign}
                  value={t.assignee?.id ?? ''}
                  onChange={(e) => {
                    if (e.target.value && currentUserId) void assignUser({ variables: { taskId: t.id, userId: e.target.value } })
                  }}
                  style={{ ...inputStyle, flex: 1, maxWidth: 250 }}
                >
                  <option value="">— Non assegnato —</option>
                  {teamUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            )
          })()}

          {/* Team gate panel */}
          {!canEdit && <TeamGatePanel teamId={responsibleTeamId} taskId={id} assigneeId={assessTask?.assignee?.id ?? planTask?.assignee?.id ?? null} />}

          {/* ── Assessment form ── */}
          {task.kind === 'assessment' && assessTask && (
            <div>
              {catalog.map((entry) => {
                const q = entry.question
                const selectedId = assessTask.responses.find(r => r.question.id === q.id)?.selectedOption.id ?? null
                return (
                  <div key={q.id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #f3f4f6' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>{q.text}</span>
                      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)', whiteSpace: 'nowrap' }}>W:{entry.weight}</span>
                    </div>
                    <select
                      disabled={!canEdit || assessTask.status === 'completed'}
                      value={selectedId ?? ''}
                      onChange={(e) => { if (e.target.value) void submitAnswer({ variables: { taskId: assessTask.id, questionId: q.id, optionId: e.target.value } }) }}
                      style={{ ...inputStyle, maxWidth: 400 }}
                    >
                      <option value="">— Seleziona —</option>
                      {q.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </div>
                )
              })}
              {assessTask.status !== 'completed' && (
                <StickyAction
                  label={`Completa (${assessTask.responses.length}/${catalog.length})`}
                  disabled={!canEdit || assessTask.responses.length < catalog.length}
                  blockReason={!canEdit ? 'Non sei nel team corretto per completare questa task' : undefined}
                  onClick={() => void completeAssess({ variables: { taskId: assessTask.id } })}
                />
              )}
            </div>
          )}

          {/* ── Deploy Plan form ── */}
          {task.kind === 'deploy-plan' && planTask && <DeployPlanForm task={planTask} canEdit={canEdit} onSave={(steps) => void savePlan({ variables: { taskId: planTask.id, steps } })} onComplete={() => void completePlan({ variables: { taskId: planTask.id } })} />}

          {/* ── Validation ── */}
          {task.kind === 'validation' && (
            <div>
              <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Verifica il CI in ambiente pre-produzione e registra l'esito.</p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" disabled={!canEdit} onClick={() => void completeVal({ variables: { changeId: task.changeId, ciId: task.ciId, result: 'pass' } })} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Pass</button>
                <button type="button" disabled={!canEdit} onClick={() => void completeVal({ variables: { changeId: task.changeId, ciId: task.ciId, result: 'fail' } })} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Fail</button>
              </div>
            </div>
          )}

          {/* ── Deployment ── */}
          {task.kind === 'deployment' && (
            <div>
              <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Conferma che il deploy in produzione è stato completato.</p>
              <button type="button" disabled={!canEdit} onClick={() => void completeDep({ variables: { changeId: task.changeId, ciId: task.ciId } })} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Conferma Deploy</button>
            </div>
          )}

          {/* ── Review ── */}
          {task.kind === 'review' && (
            <div>
              <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Verifica l'esito del deploy e conferma o rigetta.</p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" disabled={!canEdit} onClick={() => void completeRev({ variables: { changeId: task.changeId, ciId: task.ciId, result: 'confirmed' } })} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Confirmed</button>
                <button type="button" disabled={!canEdit} onClick={() => void completeRev({ variables: { changeId: task.changeId, ciId: task.ciId, result: 'rejected' } })} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Rejected</button>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Overview change ── */}
        <div style={{ position: 'sticky', top: 16 }}>
          <SectionCard title="Overview Change" collapsible={false}>
            {change && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{change.code}</span>
                  {(() => {
                    const step = change.workflowInstance?.currentStep ?? ''
                    const meta = changeStepByName.get(step)
                    return <PhaseBadge phase={step} label={meta?.label} category={meta?.category ?? null} />
                  })()}
                  <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: liveRoute.bg, color: liveRoute.color }}>{liveRoute.label}</span>
                </div>
                <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '0 0 8px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change.title}</p>
                {change.description && <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', margin: '0 0 8px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{change.description}</p>}
                <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
                  {change.requester && <span>Requestor: <strong style={{ color: 'var(--color-slate)' }}>{change.requester.name}</strong></span>}
                  {change.changeOwner && <span style={{ marginLeft: 8 }}>Owner: <strong style={{ color: 'var(--color-slate)' }}>{change.changeOwner.name}</strong></span>}
                </div>

                {/* CI table */}
                <div style={{ fontSize: 'var(--font-size-label)', marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6 }}>CI Affected</div>
                  {allAffected.map((a) => {
                    const isCurrent = a.ci.id === task.ciId
                    return (
                      <div
                        key={a.ci.id}
                        onClick={() => navigate(`/changes/${task.changeId}`)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginBottom: 2, borderRadius: 6, cursor: 'pointer',
                          background: isCurrent ? 'var(--color-brand-light)' : 'transparent',
                          borderLeft: isCurrent ? '3px solid var(--color-brand)' : '3px solid transparent',
                        }}
                      >
                        <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.ci.name}</span>
                        <CIDots a={a} />
                        <RiskBadge score={a.riskScore} />
                      </div>
                    )
                  })}
                </div>

                {/* Assessment responses for current CI */}
                {ciAffected && ciAffected.assessmentOwner?.status === 'completed' && ciAffected.assessmentSupport?.status === 'completed' && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6, fontSize: 'var(--font-size-label)' }}>
                      Risposte Assessment · {task.ciName}
                    </div>
                    {[ciAffected.assessmentOwner, ciAffected.assessmentSupport].map((at, i) => (
                      <div key={i} style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 2 }}>
                          {at.responderRole === 'owner' ? 'Functional' : 'Technical'} · Score: {at.score ?? '—'}
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                      Risk CI: <RiskBadge score={ciAffected.riskScore} />
                    </div>
                  </div>
                )}
                {ciAffected && !(ciAffected.assessmentOwner?.status === 'completed' && ciAffected.assessmentSupport?.status === 'completed') && (
                  <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
                    Owner: {ciAffected.assessmentOwner?.status ?? '—'} · Support: {ciAffected.assessmentSupport?.status ?? '—'}
                  </div>
                )}

                <Link to={`/changes/${task.changeId}`} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', textDecoration: 'none', fontWeight: 500 }}>
                  Vedi change completo →
                </Link>
              </>
            )}
          </SectionCard>
        </div>
      </div>
    </PageContainer>
  )
}

// ── StickyAction ──────────────────────────────────────────────────────────────

function StickyAction({ label, disabled, blockReason, onClick }: { label: string; disabled: boolean; blockReason?: string; onClick: () => void }) {
  return (
    <div style={{ position: 'sticky', bottom: 0, background: '#fff', borderTop: '1px solid #e5e7eb', padding: '12px 0', marginTop: 20 }}>
      <button type="button" disabled={disabled} onClick={onClick} style={{
        width: '100%', padding: '12px 24px', borderRadius: 8, border: 'none',
        backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-card-title)',
        fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}>
        {label}
      </button>
      {blockReason && <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-trigger-sla-breach)', textAlign: 'center' }}>{blockReason}</p>}
    </div>
  )
}

// ── TeamGatePanel ─────────────────────────────────────────────────────────────

function TeamGatePanel({ teamId, taskId, assigneeId }: { teamId: string | null; taskId: string; assigneeId?: string | null }) {
  const { data } = useQuery<{ team: { id: string; name: string; members: Array<{ id: string; name: string; email: string }> } | null }>(GET_TEAM_DETAIL, { variables: { id: teamId ?? '' }, skip: !teamId })
  const [sendReminder, { loading: sending }] = useMutation(SEND_TASK_REMINDER, {
    onCompleted: () => toast.success('Sollecito inviato'),
    onError:     (e) => toast.error(e.message),
  })
  const team = data?.team
  if (!team) return null
  return (
    <div style={{ padding: 16, background: '#fef9f0', border: '1px solid #fde68a', borderRadius: 8, marginBottom: 16 }}>
      <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-body)', color: '#92400e', fontWeight: 500 }}>
        Non sei nel team responsabile di questo task. Puoi sollecitare chi deve agire.
      </p>
      <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 8 }}>
        {team.name}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {team.members.map((m) => {
          const isAssigned = m.id === assigneeId
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #fde68a' }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%', backgroundColor: 'var(--color-brand-light)',
                color: 'var(--color-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--font-size-label)', fontWeight: 700, flexShrink: 0,
              }}>
                {m.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <span style={{ flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: isAssigned ? 600 : 400 }}>
                {m.name}
              </span>
              {isAssigned && (
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, backgroundColor: 'var(--color-brand-light)', color: 'var(--color-brand)' }}>
                  Assegnato
                </span>
              )}
              <button
                type="button"
                disabled={sending}
                onClick={() => void sendReminder({ variables: { taskId, userId: m.id } })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 4, border: '1px solid #fde68a',
                  background: '#fff', cursor: sending ? 'not-allowed' : 'pointer',
                  fontSize: 'var(--font-size-label)', color: '#92400e', fontWeight: 500,
                }}
              >
                <Bell size={12} /> Sollecita
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── ReopenModal ───────────────────────────────────────────────────────────────

function ReopenModal({ onConfirm, onCancel }: { onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 440, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>Riapri task</h3>
        <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Inserisci il motivo della riapertura (min 10 caratteri).</p>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', marginBottom: 16 }}
          placeholder="Motivo della riapertura..."
          autoFocus
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Annulla</button>
          <button
            type="button"
            disabled={reason.trim().length < 10}
            onClick={() => onConfirm(reason.trim())}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: '#eab308', color: '#fff', fontWeight: 600,
              cursor: reason.trim().length >= 10 ? 'pointer' : 'not-allowed',
              opacity: reason.trim().length >= 10 ? 1 : 0.5,
              fontSize: 'var(--font-size-body)',
            }}
          >
            Conferma riapertura
          </button>
        </div>
      </div>
    </div>
  )
}

// ── DeployPlanForm ────────────────────────────────────────────────────────────

function DeployPlanForm({ task, canEdit, onSave, onComplete }: {
  task: DeployPlanTask; canEdit: boolean
  onSave: (steps: DeployStep[]) => void; onComplete: () => void
}) {
  const [steps, setSteps] = useState<DeployStep[]>(task.steps ?? [])
  const [dirty, setDirty] = useState(false)
  useEffect(() => { setSteps(task.steps ?? []); setDirty(false) }, [task.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const mark = () => setDirty(true)
  const emptyStep = (): DeployStep => ({ title: '', validationWindow: { start: '', end: '' }, releaseWindow: { start: '', end: '' } })
  const isComplete = (s: DeployStep) => s.title.trim().length > 0 && !!s.validationWindow.start && !!s.validationWindow.end && !!s.releaseWindow.start && !!s.releaseWindow.end
  const allComplete = steps.length >= 1 && steps.every(isComplete)
  const completed = task.status === 'completed'

  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, marginBottom: 10, background: '#f8fafc' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={labelStyle}>Step {i + 1}</span>
            {canEdit && !completed && <button type="button" onClick={() => { setSteps(p => p.filter((_, j) => j !== i)); mark() }} style={{ background: 'none', border: '1px solid #fecaca', color: 'var(--color-danger)', cursor: 'pointer', padding: 4, borderRadius: 4 }}><X size={12} /></button>}
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Titolo *</label>
            <input type="text" disabled={!canEdit || completed} value={s.title} onChange={e => { setSteps(p => p.map((x, j) => j === i ? { ...x, title: e.target.value } : x)); mark() }} style={inputStyle} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Validazione *</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="datetime-local" disabled={!canEdit || completed} value={s.validationWindow.start ? toLocal(s.validationWindow.start) : ''} onChange={e => { setSteps(p => p.map((x, j) => j === i ? { ...x, validationWindow: { ...x.validationWindow, start: fromLocal(e.target.value) } } : x)); mark() }} style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--color-slate-light)' }}>→</span>
              <input type="datetime-local" disabled={!canEdit || completed} value={s.validationWindow.end ? toLocal(s.validationWindow.end) : ''} onChange={e => { setSteps(p => p.map((x, j) => j === i ? { ...x, validationWindow: { ...x.validationWindow, end: fromLocal(e.target.value) } } : x)); mark() }} style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Deploy *</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="datetime-local" disabled={!canEdit || completed} value={s.releaseWindow.start ? toLocal(s.releaseWindow.start) : ''} onChange={e => { setSteps(p => p.map((x, j) => j === i ? { ...x, releaseWindow: { ...x.releaseWindow, start: fromLocal(e.target.value) } } : x)); mark() }} style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--color-slate-light)' }}>→</span>
              <input type="datetime-local" disabled={!canEdit || completed} value={s.releaseWindow.end ? toLocal(s.releaseWindow.end) : ''} onChange={e => { setSteps(p => p.map((x, j) => j === i ? { ...x, releaseWindow: { ...x.releaseWindow, end: fromLocal(e.target.value) } } : x)); mark() }} style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>
        </div>
      ))}

      {canEdit && !completed && (
        <button type="button" onClick={() => { setSteps(p => [...p, emptyStep()]); mark() }} style={{ background: 'none', border: '1.5px dashed #e5e7eb', borderRadius: 8, padding: '8px 16px', color: 'var(--color-brand)', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
          <Plus size={14} /> Aggiungi step
        </button>
      )}

      {canEdit && !completed && dirty && allComplete && (
        <button type="button" onClick={() => { onSave(steps); setDirty(false) }} style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid var(--color-brand)', background: '#fff', color: 'var(--color-brand)', fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}>
          Salva piano
        </button>
      )}

      {!completed && (
        <StickyAction
          label="Completa piano"
          disabled={!canEdit || !allComplete || dirty}
          blockReason={!canEdit ? 'Non sei nel team corretto' : !allComplete ? 'Compila tutti gli step prima di completare' : dirty ? 'Salva le modifiche prima di completare' : undefined}
          onClick={onComplete}
        />
      )}
    </div>
  )
}
