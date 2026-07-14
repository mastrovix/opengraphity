/**
 * TaskViewPage — orchestrator. Loads the task, the enclosing change, and
 * everything needed for the right-hand overview, then dispatches to one of
 * the form modules under ./components based on `task.kind`.
 *
 * All shared state (plan steps being edited, reopen modal open state) lives
 * here; form components are purely controlled and receive their data +
 * callbacks via props.
 */
import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { TASK_STATUS, ASSESSMENT_ROLE, QUESTION_CATEGORY } from '@/lib/taskStatus'
import {
  GET_TASK_BY_ID,
  GET_CHANGE,
  GET_CHANGE_AFFECTED_CIS,
  GET_QUESTION_CATALOG,
  GET_ME,
  GET_USERS,
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
  REOPEN_TASK,
  REOPEN_DEPLOY_PLAN,
  REOPEN_VALIDATION,
  REOPEN_DEPLOYMENT,
  REOPEN_REVIEW,
} from '@/graphql/mutations'
import type { AffectedCI, ChangeData, DeployStep, MeData, QuestionData } from '@/types/change'
import { AssessmentTaskForm } from './components/AssessmentTaskForm'
import { PlanTaskForm } from './components/PlanTaskForm'
import { ValidationTaskForm } from './components/ValidationTaskForm'
import { DeploymentTaskForm } from './components/DeploymentTaskForm'
import { ReviewTaskForm } from './components/ReviewTaskForm'
import { ChangeOverviewSidebar } from './components/ChangeOverviewSidebar'
import { ReopenModal } from './components/ReopenModal'
import { TeamGatePanel } from './components/TeamGatePanel'
import { KIND_TITLE, inputStyle } from './components/shared'
import { AttachmentsSection } from '@/components/AttachmentsSection'

interface TaskDetail {
  id: string; code: string; kind: string
  changeId: string; changeCode: string; changeTitle: string; changePhase: string; changeDescription: string | null
  ciId: string; ciName: string; ciType: string | null; ciEnv: string | null
}
interface CatalogEntry { weight: number; sortOrder: number; question: QuestionData }

export function TaskViewPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  const id = taskId ?? ''

  const { data: taskData, loading: taskLoading } = useQuery<{ taskById: TaskDetail | null }>(GET_TASK_BY_ID, { variables: { id }, fetchPolicy: 'cache-and-network' })
  const task = taskData?.taskById

  const { data: changeData } = useQuery<{ change: ChangeData | null }>(GET_CHANGE, { variables: { id: task?.changeId ?? '' }, skip: !task, fetchPolicy: 'cache-and-network' })
  const { data: affectedData, refetch: refetchAffected } = useQuery<{ changeAffectedCIs: AffectedCI[] }>(GET_CHANGE_AFFECTED_CIS, { variables: { changeId: task?.changeId ?? '' }, skip: !task, fetchPolicy: 'cache-and-network' })
  const { data: funcCat } = useQuery<{ assessmentQuestionCatalog: CatalogEntry[] }>(GET_QUESTION_CATALOG, { variables: { category: QUESTION_CATEGORY.FUNCTIONAL }, skip: !task || (task.kind !== 'assessment') })
  const { data: techCat } = useQuery<{ assessmentQuestionCatalog: CatalogEntry[] }>(GET_QUESTION_CATALOG, { variables: { category: QUESTION_CATEGORY.TECHNICAL }, skip: !task || (task.kind !== 'assessment') })
  const { data: meData } = useQuery<{ me: MeData | null }>(GET_ME, { fetchPolicy: 'cache-first' })
  const { data: usersData } = useQuery<{ users: Array<{ id: string; name: string; teams: { id: string }[] }> }>(GET_USERS, { variables: { sortField: 'name', sortDirection: 'asc' }, fetchPolicy: 'cache-first' })
  const { byName: changeStepByName } = useWorkflowSteps('change')

  const change = changeData?.change
  const allAffected = affectedData?.changeAffectedCIs ?? []
  const ciAffected = allAffected.find(a => a.ci.id === task?.ciId) ?? null
  const isAdmin = meData?.me?.role === 'admin'
  const userTeamIds = new Set((meData?.me?.teams ?? []).map(t => t.id))
  const currentUserId = meData?.me?.id ?? null

  const getTeamUsers = (teamId: string | null | undefined): Array<{ id: string; name: string }> => {
    if (!teamId) return []
    return (usersData?.users ?? []).filter(u => u.teams.some(t => t.id === teamId)).map(u => ({ id: u.id, name: u.name }))
  }

  const refetchAll = async () => { await refetchAffected() }
  const goToChange = () => {
    const cid = taskData?.taskById?.changeId
    if (cid) { toast.success('Task completato'); navigate(`/changes/${cid}`) }
  }

  const [submitAnswer]     = useMutation(SUBMIT_ASSESSMENT_RESPONSE,   { onCompleted: refetchAll, onError: (e) => toast.error(e.message) })
  const [completeAssess]   = useMutation(COMPLETE_ASSESSMENT_TASK,     { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [assignUser]       = useMutation(ASSIGN_ASSESSMENT_TASK_TO_USER, { onCompleted: async () => { toast.success('Assegnazione aggiornata'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [savePlan]         = useMutation(SAVE_DEPLOY_PLAN,             { onCompleted: async () => { toast.success('Piano salvato'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [completePlan]     = useMutation(COMPLETE_DEPLOY_PLAN_TASK,    { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [completeVal]      = useMutation(COMPLETE_VALIDATION_TEST,     { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [completeDep]      = useMutation(COMPLETE_DEPLOYMENT,          { onCompleted: goToChange, onError: (e) => toast.error(e.message) })
  const [completeRev]      = useMutation(COMPLETE_REVIEW,              { onCompleted: goToChange, onError: (e) => toast.error(e.message) })

  const [reopenAssess]     = useMutation(REOPEN_TASK,          { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenPlan]       = useMutation(REOPEN_DEPLOY_PLAN,   { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenVal]        = useMutation(REOPEN_VALIDATION,    { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenDep]        = useMutation(REOPEN_DEPLOYMENT,    { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })
  const [reopenRev]        = useMutation(REOPEN_REVIEW,        { onCompleted: async () => { toast.success('Task riaperto'); await refetchAll() }, onError: (e) => toast.error(e.message) })

  const [showReopenModal, setShowReopenModal] = useState(false)

  // Plan-form state: lives in parent so the form stays purely controlled and
  // resets cleanly when the task id changes.
  const [planSteps, setPlanSteps] = useState<DeployStep[]>([])
  const [planDirty, setPlanDirty] = useState(false)
  const planTask = task?.kind === 'deploy-plan' ? ciAffected?.deployPlan ?? null : null
  useEffect(() => {
    if (planTask) { setPlanSteps(planTask.steps ?? []); setPlanDirty(false) }
  }, [planTask?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const assessTask = task.kind === 'assessment'
    ? (ciAffected?.assessmentOwner?.id === id ? ciAffected.assessmentOwner : ciAffected?.assessmentSupport?.id === id ? ciAffected.assessmentSupport : null)
    : null

  const assessRole = assessTask?.responderRole ?? null
  const catalog = assessRole === ASSESSMENT_ROLE.OWNER
    ? (funcCat?.assessmentQuestionCatalog ?? [])
    : assessRole === ASSESSMENT_ROLE.SUPPORT
      ? (techCat?.assessmentQuestionCatalog ?? [])
      : []

  const ciOwnerTeamId = ciAffected?.ci.ownerGroup?.id ?? null
  const ciSupportTeamId = ciAffected?.ci.supportGroup?.id ?? null
  const canEdit = isAdmin || (
    task.kind === 'assessment' ? (assessRole === ASSESSMENT_ROLE.OWNER ? !!ciOwnerTeamId && userTeamIds.has(ciOwnerTeamId) : !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId))
    : task.kind === 'deploy-plan' ? !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId)
    : task.kind === 'validation' || task.kind === 'review' ? !!ciOwnerTeamId && userTeamIds.has(ciOwnerTeamId)
    : task.kind === 'deployment' ? !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId)
    : false
  )

  const taskTitle = KIND_TITLE[task.kind] ?? task.kind

  const isTaskCompleted = (() => {
    if (task.kind === 'assessment') return assessTask?.status === TASK_STATUS.COMPLETED
    if (task.kind === 'deploy-plan') return planTask?.status === TASK_STATUS.COMPLETED
    if (task.kind === 'validation') return ciAffected?.validation?.status === TASK_STATUS.COMPLETED
    if (task.kind === 'deployment') return ciAffected?.deployment?.status === TASK_STATUS.COMPLETED
    if (task.kind === 'review') return ciAffected?.review?.status === TASK_STATUS.COMPLETED
    return false
  })()

  const responsibleTeamId = (() => {
    if (task.kind === 'assessment') return assessRole === ASSESSMENT_ROLE.OWNER ? ciOwnerTeamId : ciSupportTeamId
    if (task.kind === 'deploy-plan' || task.kind === 'deployment') return ciSupportTeamId
    return ciOwnerTeamId // validation, review
  })()

  const allScores = allAffected.filter(a => a.riskScore != null).map(a => a.riskScore!)
  const allAssessmentsDone = allAffected.length > 0 && allAffected.every(a => a.assessmentOwner?.status === TASK_STATUS.COMPLETED && a.assessmentSupport?.status === TASK_STATUS.COMPLETED)
  const liveRoute = allScores.length === 0
    ? { label: 'Da calcolare', color: 'var(--color-slate-light)', bg: '#f1f5f9' }
    : (() => {
        const max = Math.max(...allScores)
        const route = max <= 30 ? 'Auto-approvato' : max <= 60 ? 'Change Manager' : 'CAB'
        const suffix = allAssessmentsDone ? '' : ' (stima)'
        const color = allAssessmentsDone ? (max <= 30 ? '#15803d' : max <= 60 ? '#b45309' : '#b91c1c') : 'var(--color-slate)'
        const bg = allAssessmentsDone ? (max <= 30 ? '#dcfce7' : max <= 60 ? '#fef3c7' : '#fee2e2') : '#f1f5f9'
        return { label: `${route}${suffix}`, color, bg }
      })()

  const currentStep = change?.workflowInstance?.currentStep ?? ''
  const currentStepMeta = changeStepByName.get(currentStep)

  // Assignee row (assessment + deploy-plan)
  const assignable = (() => {
    if (task.kind !== 'assessment' && task.kind !== 'deploy-plan') return null
    const t = task.kind === 'assessment' ? assessTask : planTask
    if (!t) return null
    const teamId = t.assignedTeam?.id ?? null
    const teamUsers = getTeamUsers(teamId)
    const canAssign = canEdit && t.status !== TASK_STATUS.COMPLETED
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, padding: '10px 14px', background: 'var(--color-slate-bg)', borderRadius: 8, border: '1px solid #e5e7eb' }}>
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
  })()

  return (
    <PageContainer style={{ padding: '16px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
        <Link to={`/changes/${task.changeId}`} style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>{task.changeCode}</Link>
        <ChevronRight size={14} />
        <span style={{ color: 'var(--color-slate)' }}>{task.ciName}</span>
        <ChevronRight size={14} />
        <span style={{ color: 'var(--color-slate-dark)', fontWeight: 500 }}>{task.code}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 24, alignItems: 'start' }}>
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
                  border: '1px solid #eab308', background: 'var(--color-warning-bg)',
                  color: '#92400e', fontWeight: 600, cursor: 'pointer',
                  fontSize: 'var(--font-size-body)',
                }}
              >
                <RotateCcw size={14} /> Riapri task
              </button>
            )}
          </div>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 4px' }}>{taskTitle}</p>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 20px' }}>
            {task.ciName}{task.ciType ? ` · ${task.ciType}` : ''}
          </p>

          {assignable}

          {!canEdit && (
            <TeamGatePanel
              teamId={responsibleTeamId}
              taskId={id}
              assigneeId={assessTask?.assignee?.id ?? planTask?.assignee?.id ?? null}
            />
          )}

          {task.kind === 'assessment' && assessTask && (
            <AssessmentTaskForm
              task={assessTask}
              catalog={catalog}
              canEdit={canEdit}
              onSubmitAnswer={(questionId, optionId) =>
                void submitAnswer({ variables: { taskId: assessTask.id, questionId, optionId } })
              }
              onComplete={() => void completeAssess({ variables: { taskId: assessTask.id } })}
            />
          )}

          {task.kind === 'deploy-plan' && planTask && (
            <PlanTaskForm
              task={planTask}
              steps={planSteps}
              setSteps={setPlanSteps}
              dirty={planDirty}
              setDirty={setPlanDirty}
              canEdit={canEdit}
              onSave={() => {
                void savePlan({ variables: { taskId: planTask.id, steps: planSteps } })
                setPlanDirty(false)
              }}
              onComplete={() => void completePlan({ variables: { taskId: planTask.id } })}
            />
          )}

          {task.kind === 'validation' && (
            <ValidationTaskForm
              canEdit={canEdit}
              onComplete={(result) => void completeVal({ variables: { changeId: task.changeId, ciId: task.ciId, result } })}
            />
          )}

          {task.kind === 'deployment' && (
            <DeploymentTaskForm
              canEdit={canEdit}
              onComplete={() => void completeDep({ variables: { changeId: task.changeId, ciId: task.ciId } })}
            />
          )}

          {task.kind === 'review' && (
            <ReviewTaskForm
              canEdit={canEdit}
              onComplete={(result) => void completeRev({ variables: { changeId: task.changeId, ciId: task.ciId, result } })}
            />
          )}

          <div style={{ marginTop: 16 }}>
            <AttachmentsSection entityType="task" entityId={id} />
          </div>
        </div>

        <ChangeOverviewSidebar
          change={change ?? null}
          allAffected={allAffected}
          ciAffected={ciAffected}
          currentCIId={task.ciId}
          currentCIName={task.ciName}
          changeId={task.changeId}
          stepLabel={currentStepMeta?.label ?? null}
          stepCategory={currentStepMeta?.category ?? null}
          liveRoute={liveRoute}
          onRowClick={() => navigate(`/changes/${task.changeId}`)}
        />
      </div>
    </PageContainer>
  )
}
