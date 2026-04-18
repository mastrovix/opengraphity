/**
 * "Active Tasks" section: one expandable row per affected CI, showing all
 * task sub-rows (assessment/plan/validation/deployment/review) inside.
 * Modal state is local (which task's details are being inspected), so each
 * row manages its own modal opening — the list above is stateless in terms
 * of app-level workflow.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT } from '@/lib/taskStatus'
import type { AffectedCI, AssessmentTaskData } from '@/types/change'
import { AssessmentModal } from './AssessmentModal'
import { PlanModal } from './PlanModal'
import { EyeButton, OpenTaskButton, RiskBadge, TaskStatusRow } from './shared'

function CIExpandedRow({ a }: { a: AffectedCI }) {
  const bothAssessDone = a.assessmentOwner?.status === TASK_STATUS.COMPLETED && a.assessmentSupport?.status === TASK_STATUS.COMPLETED
  const [modal, setModal] = useState<'functional' | 'technical' | 'plan' | null>(null)

  const firstValStart = a.deployPlan?.steps?.[0]?.validationWindow?.start ?? null
  const firstRelStart = a.deployPlan?.steps?.[0]?.releaseWindow?.start ?? null
  const notScheduled = (d: string | null) => !d || new Date(d).getTime() <= Date.now()

  const assessAction = (task: AssessmentTaskData | null, modalKey: 'functional' | 'technical') => {
    const btns: React.ReactNode[] = []
    if (task?.status === TASK_STATUS.COMPLETED) btns.push(<EyeButton key="eye" onClick={() => setModal(modalKey)} />)
    if (task && task.status !== TASK_STATUS.COMPLETED) btns.push(<OpenTaskButton key="open" taskId={task.id} />)
    return btns.length > 0 ? <span style={{ display: 'flex', gap: 4 }}>{btns}</span> : undefined
  }

  const planAction = () => {
    const btns: React.ReactNode[] = []
    if (a.deployPlan?.status === TASK_STATUS.COMPLETED) btns.push(<EyeButton key="eye" onClick={() => setModal('plan')} />)
    if (a.deployPlan && a.deployPlan.status !== TASK_STATUS.COMPLETED) btns.push(<OpenTaskButton key="open" taskId={a.deployPlan.id} />)
    return btns.length > 0 ? <span style={{ display: 'flex', gap: 4 }}>{btns}</span> : undefined
  }

  const valAction = () => {
    if (a.validation && a.validation.status !== TASK_STATUS.COMPLETED && notScheduled(firstValStart)) return <OpenTaskButton taskId={a.validation.id} />
    return undefined
  }
  const depAction = () => {
    if (a.deployment && a.deployment.status !== TASK_STATUS.COMPLETED && a.deployment.status !== TASK_STATUS.PLANNING && notScheduled(firstRelStart)) return <OpenTaskButton taskId={a.deployment.id} />
    return undefined
  }
  const revAction = () => {
    if (a.review && a.review.status !== TASK_STATUS.COMPLETED) return <OpenTaskButton taskId={a.review.id} />
    return undefined
  }

  return (
    <div style={{ padding: '12px 0 12px 16px', fontSize: 'var(--font-size-body)' }}>
      {modal === 'functional' && a.assessmentOwner && (
        <AssessmentModal task={a.assessmentOwner} ciName={a.ci.name} roleLabel="Functional"
          bothAssessDone={bothAssessDone} onClose={() => setModal(null)} />
      )}
      {modal === 'technical' && a.assessmentSupport && (
        <AssessmentModal task={a.assessmentSupport} ciName={a.ci.name} roleLabel="Technical"
          bothAssessDone={bothAssessDone} onClose={() => setModal(null)} />
      )}
      {modal === 'plan' && (
        <PlanModal steps={a.deployPlan?.steps ?? []} ciName={a.ci.name} onClose={() => setModal(null)} />
      )}

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6 }}>Task</div>
        {a.assessmentOwner && (
          <TaskStatusRow label="Functional" code={a.assessmentOwner.code} status={a.assessmentOwner.status ?? null}
            actor={a.assessmentOwner.completedBy?.name} date={a.assessmentOwner.completedAt}
            assignedTeam={a.assessmentOwner.assignedTeam?.name} assignee={a.assessmentOwner.assignee?.name}
            action={assessAction(a.assessmentOwner, 'functional')} />
        )}
        {a.assessmentSupport && (
          <TaskStatusRow label="Technical" code={a.assessmentSupport.code} status={a.assessmentSupport.status ?? null}
            actor={a.assessmentSupport.completedBy?.name} date={a.assessmentSupport.completedAt}
            assignedTeam={a.assessmentSupport.assignedTeam?.name} assignee={a.assessmentSupport.assignee?.name}
            action={assessAction(a.assessmentSupport, 'technical')} />
        )}
        {a.deployPlan && (
          <TaskStatusRow label="Planning" code={a.deployPlan.code} status={a.deployPlan.status ?? null}
            actor={a.deployPlan.completedBy?.name} date={a.deployPlan.completedAt}
            assignedTeam={a.deployPlan.assignedTeam?.name} assignee={a.deployPlan.assignee?.name}
            action={planAction()} />
        )}
        {a.validation && (
          <TaskStatusRow label="Validation" code={a.validation.code} status={a.validation.status ?? null}
            scheduledDate={firstValStart} result={a.validation.result}
            actor={a.validation.testedBy?.name} date={a.validation.testedAt}
            action={valAction()} />
        )}
        {a.deployment && a.deployment.status !== TASK_STATUS.PLANNING && (
          <TaskStatusRow label="Deploy" code={a.deployment.code} status={a.deployment.status ?? null}
            scheduledDate={firstRelStart}
            actor={a.deployment.deployedBy?.name} date={a.deployment.deployedAt}
            action={depAction()} />
        )}
        {a.review && (
          <TaskStatusRow label="Review" code={a.review.code} status={a.review.status ?? null}
            result={a.review.result}
            actor={a.review.reviewedBy?.name} date={a.review.reviewedAt}
            action={revAction()} />
        )}
      </div>

      {bothAssessDone && (
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
          Functional score: <strong>{a.assessmentOwner?.score ?? '—'}</strong> · Technical score: <strong>{a.assessmentSupport?.score ?? '—'}</strong> · Risk CI: <RiskBadge score={a.riskScore} />
        </div>
      )}
    </div>
  )
}

export function CITasksTable({ affected, isAdmin, userTeamIds }: {
  affected: AffectedCI[]
  isAdmin: boolean
  userTeamIds: Set<string>
}) {
  const [expandedCIId, setExpandedCIId] = useState<string | null>(null)

  const findPendingTaskId = (a: AffectedCI): string | null => {
    const inTeam = (tid: string | null) => isAdmin || (!!tid && userTeamIds.has(tid))
    const oOk = inTeam(a.ci.ownerGroup?.id ?? null)
    const sOk = inTeam(a.ci.supportGroup?.id ?? null)
    if (oOk && a.assessmentOwner   && a.assessmentOwner.status   !== TASK_STATUS.COMPLETED) return a.assessmentOwner.id
    if (sOk && a.assessmentSupport && a.assessmentSupport.status !== TASK_STATUS.COMPLETED) return a.assessmentSupport.id
    if (sOk && a.deployPlan        && a.deployPlan.status        !== TASK_STATUS.COMPLETED) return a.deployPlan.id
    if (oOk && a.validation        && a.validation.status        !== TASK_STATUS.COMPLETED) return a.validation.id
    if (sOk && a.deployment        && a.deployment.status        !== TASK_STATUS.COMPLETED) return a.deployment.id
    if (oOk && a.review            && a.review.status            !== TASK_STATUS.COMPLETED) return a.review.id
    return null
  }

  return (
    <SectionCard title="Active Tasks" count={affected.length} collapsible defaultOpen>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #e5e7eb', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' }}>
        <span style={{ width: 24, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>Nome</span>
        <span style={{ width: 80 }}>Tipo</span>
        <span style={{ width: 80 }}>Env</span>
        <span style={{ width: 80 }}>Risk</span>
        <span style={{ width: 130 }}>Status</span>
        <span style={{ width: 90 }} />
      </div>
      {affected.map((a) => {
        const isOpen = expandedCIId === a.ci.id
        const tid = findPendingTaskId(a)
        const taskDone = (t: { status?: string } | null | undefined) => !t || t.status === TASK_STATUS.COMPLETED
        const validationDone = !a.validation || (a.validation.status === TASK_STATUS.COMPLETED && a.validation.result === VALIDATION_RESULT.PASS)
        const reviewDone     = !a.review     || (a.review.status     === TASK_STATUS.COMPLETED && a.review.result     === REVIEW_RESULT.CONFIRMED)
        const done =
          taskDone(a.assessmentOwner) &&
          taskDone(a.assessmentSupport) &&
          taskDone(a.deployPlan) &&
          validationDone &&
          taskDone(a.deployment) &&
          reviewDone
        return (
          <div key={a.ci.id} style={{ borderLeft: isOpen ? '3px solid var(--color-brand)' : '3px solid transparent', marginBottom: 2, transition: 'border-color 0.15s' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 8px 4px', borderBottom: '1px solid #f3f4f6' }}>
              <span onClick={() => setExpandedCIId(prev => prev === a.ci.id ? null : a.ci.id)} style={{ width: 24, flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ChevronRight size={16} color="var(--color-slate-light)" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} />
              </span>
              <span style={{ flex: 1, fontWeight: 500, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>{a.ci.name}</span>
              <span style={{ width: 80, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{a.ci.type ?? ''}</span>
              <span style={{ width: 80, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{a.ci.environment ?? ''}</span>
              <span style={{ width: 80 }}>{a.riskScore != null && (
                <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: a.riskScore <= 30 ? '#15803d' : a.riskScore <= 60 ? '#b45309' : '#b91c1c' }}>{a.riskScore}</span>
              )}</span>
              <span style={{ width: 130 }}>
                {done
                  ? <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-success)', textTransform: 'uppercase' }}>COMPLETED</span>
                  : <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-trigger-sla-breach)', textTransform: 'uppercase' }}>NOT YET COMPLETED</span>
                }
              </span>
              <span style={{ width: 90 }}>{tid && <Link to={`/tasks/${tid}`} style={{ padding: '3px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: 'var(--color-brand)', color: '#fff', textDecoration: 'none' }}>Apri task</Link>}</span>
            </div>
            {isOpen && <div style={{ paddingLeft: 28 }}><CIExpandedRow a={a} /></div>}
          </div>
        )
      })}
    </SectionCard>
  )
}
