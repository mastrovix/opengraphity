import { useState } from 'react'
import type { Team, User, ChangeTask } from './change-types'
import type { TaskHandlers } from './tasks/types'
import { AssessmentTaskList } from './tasks/AssessmentTaskList'
import { DeployStepList } from './tasks/DeployStepList'
import { ValidationTaskList } from './tasks/ValidationTaskList'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  changeId: string
  currentStep: string
  instanceId: string
  assessmentTasks: ChangeTask[]
  deploySteps: ChangeTask[]
  validationTask: ChangeTask | null
  teams: Team[]
  users: User[]
  transitioning: boolean
  completingTask: boolean
  rejectingTask: boolean
  updatingStep: boolean
  savingSteps: boolean
  savingValidation: boolean
  assessmentOpen: boolean
  deployOpen: boolean
  validationOpen: boolean
  onSetAssessmentOpen: (v: boolean) => void
  onSetDeployOpen: (v: boolean) => void
  onSetValidationOpen: (v: boolean) => void
  onExecTransition: (instanceId: string, toStep: string, notes: string | null) => void
  handlers: TaskHandlers
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ChangeTasks({
  changeId,
  currentStep,
  instanceId,
  assessmentTasks,
  deploySteps,
  validationTask,
  teams,
  users,
  transitioning,
  completingTask,
  rejectingTask,
  updatingStep,
  savingSteps,
  savingValidation,
  assessmentOpen,
  deployOpen,
  validationOpen,
  onSetAssessmentOpen,
  onSetDeployOpen,
  onSetValidationOpen,
  onExecTransition,
  handlers,
}: Props) {
  const canEditAssessment  = currentStep === 'assessment'
  const canEditDeploy      = currentStep === 'deployment'
  const canEditValidation  = currentStep === 'validation'
  const deployStepsEditable = currentStep === 'assessment'

  const showAssessmentTasks = ['assessment', 'cab_approval', 'scheduled', 'validation', 'deployment', 'completed', 'failed', 'post_review'].includes(currentStep)
  const showDeploySteps     = ['scheduled', 'validation', 'deployment', 'completed', 'failed', 'post_review'].includes(currentStep)
  const showValidation      = ['scheduled', 'validation', 'deployment', 'completed', 'failed', 'post_review'].includes(currentStep)

  // Assessment popup state
  const [assessmentTaskPopup, setAssessmentTaskPopup] = useState<string | null>(null)
  const [taskForms, setTaskForms]                     = useState<Record<string, { riskLevel: string; impactDescription: string; mitigation: string; notes: string }>>({})
  const [assignTaskUserId, setAssignTaskUserId]       = useState<Record<string, string>>({})
  const [reassignTaskId, setReassignTaskId]           = useState<string | null>(null)
  const [reassignTeamId, setReassignTeamId]           = useState('')
  const [showAllTeams, setShowAllTeams]               = useState(false)
  const [rejectTaskDialog, setRejectTaskDialog]       = useState<{ taskId: string; ciName: string } | null>(null)
  const [rejectTaskReason, setRejectTaskReason]       = useState('')

  // Deploy popup state
  const [deployStepPopup, setDeployStepPopup]               = useState<string | null>(null)
  const [deployPopupNotes, setDeployPopupNotes]             = useState('')
  const [deployPopupShowSkip, setDeployPopupShowSkip]       = useState(false)
  const [deployPopupSkipReason, setDeployPopupSkipReason]   = useState('')
  const [deployPopupShowFail, setDeployPopupShowFail]       = useState(false)
  const [deployPopupFailReason, setDeployPopupFailReason]   = useState('')
  const [deployPopupReassignTeamId, setDeployPopupReassignTeamId] = useState('')
  const [deployPopupShowReassign, setDeployPopupShowReassign]     = useState(false)
  const [deployPopupUserId, setDeployPopupUserId]           = useState('')

  // Validation popup state
  const [validationStepPopup, setValidationStepPopup]       = useState<string | null>(null)
  const [valPopupNotes, setValPopupNotes]                   = useState('')
  const [valPopupReassignTeamId, setValPopupReassignTeamId] = useState('')
  const [valPopupShowReassign, setValPopupShowReassign]     = useState(false)
  const [valPopupUserId, setValPopupUserId]                 = useState('')
  const [globalValidationPopup, setGlobalValidationPopup]   = useState(false)
  const [globalValNotes, setGlobalValNotes]                 = useState('')

  // New step form state
  const [newStepForm, setNewStepForm] = useState({
    title: '', scheduledStart: new Date().toISOString().split('T')[0] ?? '',
    durationDays: 1, scheduledEnd: '', hasValidation: false,
    validationStart: '', validationEnd: '', assignedTeamId: '', validationTeamId: '',
  })
  const [globalValidationStart, setGlobalValidationStart] = useState('')
  const [globalValidationEnd, setGlobalValidationEnd]     = useState('')

  function calcEnd(start: string, days: number): string {
    if (!start || !days) return ''
    const d = new Date(start)
    d.setDate(d.getDate() + days)
    return d.toISOString().split('T')[0] ?? ''
  }

  function setTaskForm(taskId: string, patch: Partial<{ riskLevel: string; impactDescription: string; mitigation: string; notes: string }>) {
    setTaskForms((prev) => {
      const current = prev[taskId] ?? { riskLevel: 'low', impactDescription: '', mitigation: '', notes: '' }
      return { ...prev, [taskId]: { ...current, ...patch } }
    })
  }

  return (
    <>
      {/* Assessment Tasks */}
      {showAssessmentTasks && assessmentTasks.length > 0 && (
        <AssessmentTaskList
          changeId={changeId}
          assessmentTasks={assessmentTasks}
          deploySteps={deploySteps}
          validationTask={validationTask}
          teams={teams}
          users={users}
          canEditAssessment={canEditAssessment}
          deployStepsEditable={deployStepsEditable}
          assessmentOpen={assessmentOpen}
          onSetAssessmentOpen={onSetAssessmentOpen}
          completingTask={completingTask}
          rejectingTask={rejectingTask}
          savingSteps={savingSteps}
          savingValidation={savingValidation}
          assessmentTaskPopup={assessmentTaskPopup}
          setAssessmentTaskPopup={setAssessmentTaskPopup}
          taskForms={taskForms}
          setTaskForm={setTaskForm}
          assignTaskUserId={assignTaskUserId}
          setAssignTaskUserId={setAssignTaskUserId}
          setReassignTaskId={setReassignTaskId}
          setReassignTeamId={setReassignTeamId}
          setRejectTaskDialog={setRejectTaskDialog}
          newStepForm={newStepForm}
          setNewStepForm={setNewStepForm}
          globalValidationStart={globalValidationStart}
          setGlobalValidationStart={setGlobalValidationStart}
          globalValidationEnd={globalValidationEnd}
          setGlobalValidationEnd={setGlobalValidationEnd}
          calcEnd={calcEnd}
          handlers={handlers}
        />
      )}

      {/* Validation Tasks */}
      {showValidation && (
        <ValidationTaskList
          changeId={changeId}
          deploySteps={deploySteps}
          validationTask={validationTask}
          teams={teams}
          users={users}
          canEditValidation={canEditValidation}
          transitioning={transitioning}
          instanceId={instanceId}
          validationOpen={validationOpen}
          onSetValidationOpen={onSetValidationOpen}
          updatingStep={updatingStep}
          onExecTransition={onExecTransition}
          validationStepPopup={validationStepPopup}
          setValidationStepPopup={setValidationStepPopup}
          valPopupNotes={valPopupNotes}
          setValPopupNotes={setValPopupNotes}
          valPopupReassignTeamId={valPopupReassignTeamId}
          setValPopupReassignTeamId={setValPopupReassignTeamId}
          valPopupShowReassign={valPopupShowReassign}
          setValPopupShowReassign={setValPopupShowReassign}
          valPopupUserId={valPopupUserId}
          setValPopupUserId={setValPopupUserId}
          globalValidationPopup={globalValidationPopup}
          setGlobalValidationPopup={setGlobalValidationPopup}
          globalValNotes={globalValNotes}
          setGlobalValNotes={setGlobalValNotes}
          handlers={handlers}
        />
      )}

      {/* Deploy Tasks (readonly table) */}
      {showDeploySteps && !deployStepsEditable && (
        <DeployStepList
          deploySteps={deploySteps}
          teams={teams}
          users={users}
          canEditDeploy={canEditDeploy}
          deployOpen={deployOpen}
          onSetDeployOpen={onSetDeployOpen}
          updatingStep={updatingStep}
          deployStepPopup={deployStepPopup}
          setDeployStepPopup={setDeployStepPopup}
          deployPopupNotes={deployPopupNotes}
          setDeployPopupNotes={setDeployPopupNotes}
          deployPopupShowSkip={deployPopupShowSkip}
          setDeployPopupShowSkip={setDeployPopupShowSkip}
          deployPopupSkipReason={deployPopupSkipReason}
          setDeployPopupSkipReason={setDeployPopupSkipReason}
          deployPopupShowFail={deployPopupShowFail}
          setDeployPopupShowFail={setDeployPopupShowFail}
          deployPopupFailReason={deployPopupFailReason}
          setDeployPopupFailReason={setDeployPopupFailReason}
          deployPopupReassignTeamId={deployPopupReassignTeamId}
          setDeployPopupReassignTeamId={setDeployPopupReassignTeamId}
          deployPopupShowReassign={deployPopupShowReassign}
          setDeployPopupShowReassign={setDeployPopupShowReassign}
          deployPopupUserId={deployPopupUserId}
          setDeployPopupUserId={setDeployPopupUserId}
          handlers={handlers}
        />
      )}

      {/* Reassign Task Dialog */}
      {reassignTaskId && (() => {
        const taskToReassign = assessmentTasks.find((t) => t.id === reassignTaskId)
        const ownerGroup    = taskToReassign?.ci?.owner   ?? null
        const supportGroup  = taskToReassign?.ci?.supportGroup ?? null
        const currentTeamId = taskToReassign?.assignedTeam?.id ?? null
        const availableTeams = ([ownerGroup, supportGroup] as ({ id: string; name: string } | null)[])
          .filter(Boolean)
          .filter((t) => t?.id !== currentTeamId)
          .filter((t, i, arr) => arr.findIndex((x) => x?.id === t?.id) === i) as { id: string; name: string }[]
        const teamList = showAllTeams ? teams : availableTeams
        return (
          <>
            <div onClick={() => { setReassignTaskId(null); setShowAllTeams(false) }} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.5)' }} />
            <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 400, zIndex: 1001, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: 'var(--color-slate-dark)' }}>Riassegna task</h3>
              {taskToReassign?.ci && (
                <p style={{ fontSize: 12, color: 'var(--color-slate-light)', margin: '0 0 16px' }}>CI: <strong>{taskToReassign.ci.name}</strong></p>
              )}
              {teamList.length > 0 ? (
                <select
                  value={reassignTeamId}
                  onChange={(e) => setReassignTeamId(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, marginBottom: 8, outline: 'none' }}
                >
                  <option value="">Seleziona team…</option>
                  {teamList.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              ) : (
                <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 8 }}>Nessun team alternativo disponibile per questo CI.</p>
              )}
              {!showAllTeams && (
                <button onClick={() => setShowAllTeams(true)} style={{ fontSize: 12, color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}>
                  Scegli da tutti i team →
                </button>
              )}
              {showAllTeams && <div style={{ marginBottom: 16 }} />}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => { setReassignTaskId(null); setShowAllTeams(false) }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 14 }}>Annulla</button>
                <button
                  disabled={!reassignTeamId}
                  onClick={() => {
                    handlers.onAssignTaskTeam(reassignTaskId, reassignTeamId)
                    setAssignTaskUserId((prev) => ({ ...prev, [reassignTaskId]: '' }))
                    setReassignTaskId(null)
                    setReassignTeamId('')
                    setShowAllTeams(false)
                  }}
                  style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: reassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: reassignTeamId ? 'var(--color-brand)' : '#e2e6f0', color: reassignTeamId ? '#fff' : 'var(--color-slate-light)', fontSize: 14, fontWeight: 500 }}
                >
                  Riassegna
                </button>
              </div>
            </div>
          </>
        )
      })()}

      {/* Reject Task Dialog */}
      {rejectTaskDialog && (
        <>
          <div onClick={() => setRejectTaskDialog(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.5)' }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 440, zIndex: 1001, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: 'var(--color-slate-dark)' }}>
              Rigetta task: {rejectTaskDialog.ciName}
            </h3>
            <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 16 }}>
              Il CI verrà rimosso dagli affected e il task sarà marcato come saltato. Motivo obbligatorio (min. 10 caratteri).
            </p>
            <textarea
              value={rejectTaskReason}
              onChange={(e) => setRejectTaskReason(e.target.value)}
              placeholder="Es: CI non rilevante per questo change..."
              rows={3}
              autoFocus
              style={{ width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => setRejectTaskDialog(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 14 }}>Annulla</button>
              <button
                disabled={rejectTaskReason.trim().length < 10}
                onClick={() => {
                  handlers.onRejectTask(rejectTaskDialog.taskId, rejectTaskReason.trim())
                  setRejectTaskDialog(null)
                  setRejectTaskReason('')
                }}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 500, cursor: rejectTaskReason.trim().length >= 10 ? 'pointer' : 'not-allowed', backgroundColor: rejectTaskReason.trim().length >= 10 ? 'var(--color-trigger-sla-breach)' : '#f3f4f6', color: rejectTaskReason.trim().length >= 10 ? '#fff' : 'var(--color-slate-light)' }}
              >
                Conferma rigetto
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
