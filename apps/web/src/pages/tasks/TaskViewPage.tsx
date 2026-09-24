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
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { TASK_STATUS, ASSESSMENT_ROLE, QUESTION_CATEGORY } from '@/lib/taskStatus'
import {
  GET_TASK_BY_ID,
  GET_CHANGE,
  GET_CHANGE_AFFECTED_CIS,
  GET_QUESTION_CATALOG,
  GET_TEAM_DETAIL,
} from '@/graphql/queries'
import { useMe } from '@/hooks/useMe'
import { useTaskMutations } from './useTaskMutations'
import type { AffectedCI, AssessmentTaskData, ChangeData, DeployPlanTaskData, DeployStep, MeData, QuestionData } from '@/types/change'
import { AssessmentTaskForm } from './components/AssessmentTaskForm'
import { PlanTaskForm } from './components/PlanTaskForm'
import { ValidationTaskForm } from './components/ValidationTaskForm'
import { DeploymentTaskForm } from './components/DeploymentTaskForm'
import { ReviewTaskForm } from './components/ReviewTaskForm'
import { ChangeOverviewSidebar } from './components/ChangeOverviewSidebar'
import { ReopenModal } from './components/ReopenModal'
import { TeamGatePanel } from './components/TeamGatePanel'
import { KIND_TITLE_KEY, inputStyle } from './components/shared'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { DetailLayout } from '@/components/ui/DetailLayout'
import { colors, palette } from '@/lib/tokens'
import { plannedWindowStart, beforePlannedWindow } from './components/plannedWindow'
import { useConfirm } from '@/hooks/useConfirm'
import { formatDateTime } from '@/lib/datetime'
import { useCILabels } from '@/hooks/useCILabels'
import { reloadQueries } from '@/lib/reloadQueries'

interface TaskDetail {
  id: string; code: string; kind: string
  changeId: string; changeCode: string; changeTitle: string; changePhase: string; changeDescription: string | null
  ciId: string; ciName: string; ciType: string | null; ciEnv: string | null
}
interface CatalogEntry { weight: number; sortOrder: number; question: QuestionData }

/** Whether the task is done: each kind reads its own row of the CI in the change. */
function taskCompleted(kind: string, { assessTask, planTask, ciAffected }: {
  assessTask: AssessmentTaskData | null
  planTask: DeployPlanTaskData | null
  ciAffected: AffectedCI | null
}): boolean {
  if (kind === 'assessment') return assessTask?.status === TASK_STATUS.COMPLETED
  if (kind === 'deploy-plan') return planTask?.status === TASK_STATUS.COMPLETED
  if (kind === 'validation') return ciAffected?.validation?.status === TASK_STATUS.COMPLETED
  if (kind === 'deployment') return ciAffected?.deployment?.status === TASK_STATUS.COMPLETED
  if (kind === 'review') return ciAffected?.review?.status === TASK_STATUS.COMPLETED
  return false
}

export function TaskViewPage() {
  const { t } = useTranslation()
  const ciLabels = useCILabels()
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  const id = taskId ?? ''

  const { data: taskData, loading: taskLoading, error: taskError, refetch: refetchTask } = useQuery<{ taskById: TaskDetail | null }>(GET_TASK_BY_ID, { variables: { id }, fetchPolicy: 'cache-and-network' })
  const task = taskData?.taskById

  const { data: changeData } = useQuery<{ change: ChangeData | null }>(GET_CHANGE, { variables: { id: task?.changeId ?? '' }, skip: !task, fetchPolicy: 'cache-and-network' })
  const { data: affectedData, refetch: refetchAffected } = useQuery<{ changeAffectedCIs: AffectedCI[] }>(GET_CHANGE_AFFECTED_CIS, { variables: { changeId: task?.changeId ?? '' }, skip: !task, fetchPolicy: 'cache-and-network' })
  const funcCat = useQuery<{ assessmentQuestionCatalog: CatalogEntry[] }>(GET_QUESTION_CATALOG, { variables: { category: QUESTION_CATEGORY.FUNCTIONAL }, skip: !task || (task.kind !== 'assessment') })
  const techCat = useQuery<{ assessmentQuestionCatalog: CatalogEntry[] }>(GET_QUESTION_CATALOG, { variables: { category: QUESTION_CATEGORY.TECHNICAL }, skip: !task || (task.kind !== 'assessment') })
  const { me, can } = useMe()
  const meData: { me: MeData | null } = { me }
  const { byName: changeStepByName } = useWorkflowSteps('change')

  const change = changeData?.change
  const allAffected = affectedData?.changeAffectedCIs ?? []
  const ciAffected = allAffected.find(a => a.ci.id === task?.ciId) ?? null
  // Chi agisce per qualunque team (approval.override, ondata 7; prima «admin»).
  const actsForAnyTeam = can('approval.override')
  const userTeamIds = new Set((meData?.me?.teams ?? []).map(t => t.id))

  // Team assegnatario del task assegnabile (assessment/deploy-plan): si caricano solo i suoi membri,
  // non l'intera anagrafica utenti.
  const assignableTeamId = task?.kind === 'assessment'
    ? ((ciAffected?.assessmentOwner?.id === id ? ciAffected?.assessmentOwner : ciAffected?.assessmentSupport?.id === id ? ciAffected?.assessmentSupport : null)?.assignedTeam?.id ?? null)
    : task?.kind === 'deploy-plan' ? (ciAffected?.deployPlan?.assignedTeam?.id ?? null) : null
  const { data: teamData } = useQuery<{ team: { id: string; members: Array<{ id: string; name: string }> } | null }>(GET_TEAM_DETAIL, { variables: { id: assignableTeamId ?? '' }, skip: !assignableTeamId, // F-39: `cache-first` non ricaricava più i membri nella sessione, quindi
    // una persona aggiunta al team dopo l'apertura dell'app non compariva fra
    // gli assegnabili finché non si ricaricava la pagina.
    fetchPolicy: 'cache-and-network' })
  const getTeamUsers = (teamId: string | null | undefined): Array<{ id: string; name: string }> => {
    if (!teamId || teamId !== assignableTeamId) return []
    return (teamData?.team?.members ?? []).map(u => ({ id: u.id, name: u.name }))
  }

  const refetchAll = () => { reloadQueries(refetchAffected) }
  const goToChange = () => {
    const cid = taskData?.taskById?.changeId
    if (cid) { toast.success(t('toast.task.completed')); navigate(`/changes/${cid}`) }
  }

  // D24: the mutations live in one hook, which also says when a completion,
  // an answer or the plan is in flight — the buttons wait for it.
  const m = useTaskMutations({ refetchAll, goToChange })
  const busyLabel = m.completing ? t('changeTasks.completing') : m.saving ? t('common.saving') : null

  // Completare prima della finestra pianificata si può, ma lo si conferma.
  const confirm = useConfirm()
  const confirmBeforeWindow = async (kind: 'validation' | 'deployment'): Promise<boolean> => {
    const start = plannedWindowStart(ciAffected?.deployPlan?.steps, kind)
    if (!beforePlannedWindow(start)) return true
    return confirm({
      title: t('pages.tasks.beforeWindow.title'),
      body:  t(kind === 'validation' ? 'pages.tasks.beforeWindow.validation' : 'pages.tasks.beforeWindow.deployment', { when: formatDateTime(start) }),
      confirmLabel: t('pages.tasks.beforeWindow.confirm'),
    })
  }

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
    if (kind === 'assessment') void m.reopenAssess({ variables: { taskId: id, reason } })
    else if (kind === 'deploy-plan') void m.reopenPlan({ variables: { taskId: id, reason } })
    else if (kind === 'validation') void m.reopenVal({ variables: { id, reason } })
    else if (kind === 'deployment') void m.reopenDep({ variables: { id, reason } })
    else if (kind === 'review') void m.reopenRev({ variables: { id, reason } })
  }

  if (taskLoading && !task) return <PageContainer><p>{t('common.loading')}</p></PageContainer>
  if (taskError && !taskData) return <PageContainer><QueryError message={taskError.message} onRetry={() => void refetchTask()} /></PageContainer>
  if (!task) return <PageContainer><p>{t('pages.taskView.notFound')}</p></PageContainer>

  const assessTask = task.kind === 'assessment'
    ? (ciAffected?.assessmentOwner?.id === id ? ciAffected.assessmentOwner : ciAffected?.assessmentSupport?.id === id ? ciAffected.assessmentSupport : null)
    : null

  const assessRole = assessTask?.responderRole ?? null
  // The questionnaire of this responder; `null` while it is not known (not read yet, or not
  // readable). Taken for an empty one, it offered «Complete (0/0)», which the API always refuses.
  const catalogRead = assessRole === ASSESSMENT_ROLE.OWNER ? funcCat : assessRole === ASSESSMENT_ROLE.SUPPORT ? techCat : null
  const catalog = catalogRead ? (catalogRead.data?.assessmentQuestionCatalog ?? null) : []

  const ciOwnerTeamId = ciAffected?.ci.ownerGroup?.id ?? null
  const ciSupportTeamId = ciAffected?.ci.supportGroup?.id ?? null
  const canEdit = actsForAnyTeam || (
    task.kind === 'assessment' ? (assessRole === ASSESSMENT_ROLE.OWNER ? !!ciOwnerTeamId && userTeamIds.has(ciOwnerTeamId) : !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId))
    : task.kind === 'deploy-plan' ? !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId)
    : task.kind === 'validation' || task.kind === 'review' ? !!ciOwnerTeamId && userTeamIds.has(ciOwnerTeamId)
    : task.kind === 'deployment' ? !!ciSupportTeamId && userTeamIds.has(ciSupportTeamId)
    : false
  )

  const taskTitle = KIND_TITLE_KEY[task.kind] ? t(KIND_TITLE_KEY[task.kind]!) : task.kind

  const isTaskCompleted = taskCompleted(task.kind, { assessTask, planTask, ciAffected })

  const responsibleTeamId = (() => {
    if (task.kind === 'assessment') return assessRole === ASSESSMENT_ROLE.OWNER ? ciOwnerTeamId : ciSupportTeamId
    if (task.kind === 'deploy-plan' || task.kind === 'deployment') return ciSupportTeamId
    return ciOwnerTeamId // validation, review
  })()


  const currentStep = change?.workflowInstance?.currentStep ?? ''
  const currentStepMeta = changeStepByName.get(currentStep)

  // Assignee row (assessment + deploy-plan)
  const assignable = (() => {
    if (task.kind !== 'assessment' && task.kind !== 'deploy-plan') return null
    const tsk = task.kind === 'assessment' ? assessTask : planTask
    if (!tsk) return null
    const teamId = tsk.assignedTeam?.id ?? null
    const teamUsers = getTeamUsers(teamId)
    const canAssign = canEdit && tsk.status !== TASK_STATUS.COMPLETED
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, padding: '10px 14px', background: 'var(--color-slate-bg)', borderRadius: 8, border: `1px solid ${colors.border}` }}>
        <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>
          {t('sidebar.teams')}: {tsk.assignedTeam?.name ?? '—'}
        </span>
        <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginLeft: 12 }}>{t('pages.taskView.assignedTo')}</span>
        <select
          aria-label={t('pages.taskView.assignedTo')}
          disabled={!canAssign}
          value={tsk.assignee?.id ?? ''}
          onChange={(e) => {
            // «Non assegnato» (valore vuoto) manda userId null e TOGLIE
            // l'assegnazione: prima l'opzione c'era e non faceva nulla
            // (revisione totale · F-4).
            const assign = task.kind === 'deploy-plan' ? m.assignPlanUser : m.assignUser
            void assign({ variables: { taskId: tsk.id, userId: e.target.value || null } })
          }}
          style={{ ...inputStyle, flex: 1, maxWidth: 250 }}
        >
          <option value="">{t('pages.taskView.unassigned')}</option>
          {teamUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
    )
  })()

  return (
    <PageContainer style={{ padding: '16px 24px' }}>
      {/* Il codice dell'attività è il titolo della pagina: il percorso finisce sul
          tipo di attività, altrimenti «TASK…» si leggeva due volte di fila. */}
      <nav aria-label={t('topbar.breadcrumb')} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>
        <Link to={`/changes/${task.changeId}`} style={{ color: 'var(--color-brand)', textDecoration: 'none' }}>{task.changeCode}</Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span style={{ color: 'var(--color-slate)' }}>{task.ciName}</span>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page" style={{ color: 'var(--color-slate-dark)', fontWeight: 500 }}>{taskTitle}</span>
      </nav>

      <DetailLayout sideWidth={360}>
        <div>
          {showReopenModal && <ReopenModal onConfirm={handleReopen} onCancel={() => setShowReopenModal(false)} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
            <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
              {task.code}
            </h1>
            {actsForAnyTeam && isTaskCompleted && (
              <button
                type="button"
                onClick={() => setShowReopenModal(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 6,
                  border: `1px solid ${colors.warning}`, background: 'var(--color-warning-bg)',
                  color: palette.warning.strong, fontWeight: 600, cursor: 'pointer',
                  fontSize: 'var(--font-size-body)',
                }}
              >
                <RotateCcw size={14} /> {t('changeTasks.reopenTask')}
              </button>
            )}
          </div>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 20px' }}>
            {/* Secondo giro UI · V-2: etichette, non «application»/«business_application». */}
            {task.ciName}{task.ciType ? ` · ${ciLabels.subtitle({ type: task.ciType, environment: task.ciEnv })}` : ''}
          </p>

          {assignable}

          {!canEdit && (
            <TeamGatePanel
              teamId={responsibleTeamId}
              taskId={id}
              assigneeId={assessTask?.assignee?.id ?? planTask?.assignee?.id ?? null}
            />
          )}

          {task.kind === 'assessment' && assessTask && catalog === null && (
            catalogRead?.error
              ? <QueryError message={t('pages.taskView.questionsUnavailable', { error: catalogRead.error.message })} onRetry={() => void catalogRead.refetch()} />
              : <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('common.loading')}</p>
          )}

          {task.kind === 'assessment' && assessTask && catalog !== null && (
            <AssessmentTaskForm
              task={assessTask}
              catalog={catalog}
              canEdit={canEdit}
              busyLabel={busyLabel}
              onSubmitAnswer={(questionId, optionId) =>
                void m.submitAnswer({ variables: { taskId: assessTask.id, questionId, optionId } })
              }
              onComplete={() => void m.completeAssess({ variables: { taskId: assessTask.id } })}
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
              busyLabel={busyLabel}
              // The plan is «saved» only when the server says so (review of 23 Sep
              // 2026): a refused save cleared the flag anyway, hid «Save» and
              // enabled «Complete» over steps that were not the saved ones.
              onSave={async () => {
                // A refusal is said by the mutation's `onError`; Apollo 4 also
                // rejects the promise, and the plan simply stays unsaved.
                const res = await m.savePlan({ variables: { taskId: planTask.id, steps: planSteps } }).catch(() => null)
                if (res?.data && !res.error) setPlanDirty(false)
              }}
              onComplete={() => void m.completePlan({ variables: { taskId: planTask.id } })}
            />
          )}

          {task.kind === 'validation' && (
            <ValidationTaskForm
              canEdit={canEdit}
              busyLabel={busyLabel}
              onComplete={(result) => void confirmBeforeWindow('validation').then((ok) => { if (ok) void m.completeVal({ variables: { changeId: task.changeId, ciId: task.ciId, result } }) })}
            />
          )}

          {task.kind === 'deployment' && (
            <DeploymentTaskForm
              canEdit={canEdit}
              busyLabel={busyLabel}
              onComplete={() => void confirmBeforeWindow('deployment').then((ok) => { if (ok) void m.completeDep({ variables: { changeId: task.changeId, ciId: task.ciId } }) })}
            />
          )}

          {task.kind === 'review' && (
            <ReviewTaskForm
              canEdit={canEdit}
              busyLabel={busyLabel}
              onComplete={(result) => void m.completeRev({ variables: { changeId: task.changeId, ciId: task.ciId, result } })}
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
          onRowClick={() => navigate(`/changes/${task.changeId}`)}
        />
      </DetailLayout>
    </PageContainer>
  )
}
