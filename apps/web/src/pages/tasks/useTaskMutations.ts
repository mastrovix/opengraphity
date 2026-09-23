/**
 * THE MUTATIONS OF A CHANGE TASK, AND WHETHER ONE IS IN FLIGHT (D24, tour of
 * 23 Sep 2026).
 *
 * «Complete (5/5)» stayed enabled while the completion was on its way — it can
 * take seconds — and a second click came back as the red toast «This task is
 * already completed». The page needs to know that a completion (or an answer,
 * or a plan save, which change what the completion would send) is in flight,
 * and that is easiest where the mutations are declared: here, in one place,
 * instead of fifteen `loading` flags in the page.
 */
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  SUBMIT_ASSESSMENT_RESPONSE,
  COMPLETE_ASSESSMENT_TASK,
  ASSIGN_ASSESSMENT_TASK_TO_USER,
  ASSIGN_DEPLOY_PLAN_TASK_TO_USER,
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
import { showError } from '@/lib/showError'

export function useTaskMutations({ refetchAll, goToChange }: { refetchAll: () => void; goToChange: () => void }) {
  const { t } = useTranslation()
  const onError = (e: unknown) => showError(e)
  // Apollo drops what onCompleted returns: the reload runs on its own (see lib/reloadQueries).
  const assigned = () => { toast.success(t('toast.task.assignmentUpdated')); refetchAll() }
  const reopened = () => { toast.success(t('toast.task.reopened')); refetchAll() }

  const [submitAnswer, answer]     = useMutation(SUBMIT_ASSESSMENT_RESPONSE,      { onCompleted: refetchAll, onError })
  const [completeAssess, assess]   = useMutation(COMPLETE_ASSESSMENT_TASK,        { onCompleted: goToChange, onError })
  const [assignUser]               = useMutation(ASSIGN_ASSESSMENT_TASK_TO_USER,  { onCompleted: assigned, onError })
  const [assignPlanUser]           = useMutation(ASSIGN_DEPLOY_PLAN_TASK_TO_USER, { onCompleted: assigned, onError })
  const [savePlan, save]           = useMutation(SAVE_DEPLOY_PLAN,                { onCompleted: () => { toast.success(t('toast.task.planSaved')); refetchAll() }, onError })
  const [completePlan, plan]       = useMutation(COMPLETE_DEPLOY_PLAN_TASK,       { onCompleted: goToChange, onError })
  const [completeVal, validation]  = useMutation(COMPLETE_VALIDATION_TEST,        { onCompleted: goToChange, onError })
  const [completeDep, deployment]  = useMutation(COMPLETE_DEPLOYMENT,             { onCompleted: goToChange, onError })
  const [completeRev, review]      = useMutation(COMPLETE_REVIEW,                 { onCompleted: goToChange, onError })

  const [reopenAssess] = useMutation(REOPEN_TASK,        { onCompleted: reopened, onError })
  const [reopenPlan]   = useMutation(REOPEN_DEPLOY_PLAN, { onCompleted: reopened, onError })
  const [reopenVal]    = useMutation(REOPEN_VALIDATION,  { onCompleted: reopened, onError })
  const [reopenDep]    = useMutation(REOPEN_DEPLOYMENT,  { onCompleted: reopened, onError })
  const [reopenRev]    = useMutation(REOPEN_REVIEW,      { onCompleted: reopened, onError })

  return {
    submitAnswer, completeAssess, assignUser, assignPlanUser, savePlan, completePlan, completeVal, completeDep, completeRev,
    reopenAssess, reopenPlan, reopenVal, reopenDep, reopenRev,
    /** A completion of this task is on its way: no second click. */
    completing: assess.loading || plan.loading || validation.loading || deployment.loading || review.loading,
    /** An answer or the plan is being saved: completing now would send what is about to change. */
    saving: answer.loading || save.loading,
  }
}
