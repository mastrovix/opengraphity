import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { DetailField } from '@/components/ui/DetailField'
import type { Team, User, ChangeTask } from './change-types'
import { Badge, STATUS_STEP_COLORS, TASK_STATUS_COLORS, formatDate, groupByField, cardStyle, inputStyle, textareaStyle } from './change-types'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TaskHandlers {
  // Assessment task
  onCompleteTask: (taskId: string, input: { riskLevel: string; impactDescription: string; mitigation: string | null; notes: string | null }) => void
  onRejectTask: (taskId: string, reason: string) => void
  onAssignTaskTeam: (taskId: string, teamId: string) => void
  onAssignTaskUser: (taskId: string, userId: string) => void
  // Deploy step
  onUpdateStepStatus: (stepId: string, status: string, notes?: string, skipReason?: string) => void
  onAssignStepTeam: (stepId: string, teamId: string) => void
  onAssignStepUser: (stepId: string, userId: string) => void
  onUpdateStepValidation: (stepId: string, status: string, notes: string | null) => void
  onAssignValidationTeam: (stepId: string, teamId: string) => void
  onAssignValidationUser: (stepId: string, userId: string) => void
  onUpdateChangeTask: (id: string, input: { rollbackPlan?: string }) => void
  // Global validation
  onCompleteValidation: (changeId: string, notes: string | null) => void
  onFailValidation: (changeId: string) => void
  // Deploy steps form
  onSaveSteps: (changeId: string, steps: object[]) => void
  onSaveValidation: (changeId: string, scheduledStart: string, scheduledEnd: string) => void
}

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

// ── Task card style helper ────────────────────────────────────────────────────

function taskCardStyle(taskType: string, canEdit: boolean): React.CSSProperties {
  const colors: Record<string, string> = {
    assessment: 'var(--color-brand)',
    deploy:     '#0891b2',
    validation: 'var(--color-trigger-automatic)',
  }
  return {
    ...cardStyle,
    borderLeft: canEdit ? `4px solid ${colors[taskType]}` : '4px solid #e5e7eb',
    borderRadius: '0 10px 10px 0',
    background: canEdit ? '#fff' : '#fafafa',
    padding: 0,
    transition: 'all 0.2s',
  }
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
  const canEditAssessment = currentStep === 'assessment'
  const canEditDeploy     = currentStep === 'deployment'
  const canEditValidation = currentStep === 'validation'
  const deployStepsEditable = currentStep === 'assessment'

  const showAssessmentTasks = ['assessment', 'cab_approval', 'scheduled', 'validation', 'deployment', 'completed', 'failed', 'post_review'].includes(currentStep)
  const showDeploySteps     = ['scheduled', 'validation', 'deployment', 'completed', 'failed', 'post_review'].includes(currentStep)
  const showValidation      = ['scheduled', 'validation', 'deployment', 'completed', 'failed', 'post_review'].includes(currentStep)

  // Assessment task popup
  const [assessmentTaskPopup, setAssessmentTaskPopup] = useState<string | null>(null)
  const [taskForms, setTaskForms]                     = useState<Record<string, { riskLevel: string; impactDescription: string; mitigation: string; notes: string }>>({})
  const [assignTaskUserId, setAssignTaskUserId]       = useState<Record<string, string>>({})

  // Reassign task dialog (opened from assessment popup)
  const [reassignTaskId, setReassignTaskId]   = useState<string | null>(null)
  const [reassignTeamId, setReassignTeamId]   = useState('')
  const [showAllTeams, setShowAllTeams]       = useState(false)

  // Reject task dialog (opened from assessment popup)
  const [rejectTaskDialog, setRejectTaskDialog] = useState<{ taskId: string; ciName: string } | null>(null)
  const [rejectTaskReason, setRejectTaskReason] = useState('')

  // Deploy step popup
  const [deployStepPopup, setDeployStepPopup]               = useState<string | null>(null)
  const [deployPopupNotes, setDeployPopupNotes]             = useState('')
  const [deployPopupShowSkip, setDeployPopupShowSkip]       = useState(false)
  const [deployPopupSkipReason, setDeployPopupSkipReason]   = useState('')
  const [deployPopupShowFail, setDeployPopupShowFail]       = useState(false)
  const [deployPopupFailReason, setDeployPopupFailReason]   = useState('')
  const [deployPopupReassignTeamId, setDeployPopupReassignTeamId] = useState('')
  const [deployPopupShowReassign, setDeployPopupShowReassign]     = useState(false)
  const [deployPopupUserId, setDeployPopupUserId]           = useState('')

  // Validation step popup
  const [validationStepPopup, setValidationStepPopup]             = useState<string | null>(null)
  const [valPopupNotes, setValPopupNotes]                         = useState('')
  const [valPopupReassignTeamId, setValPopupReassignTeamId]       = useState('')
  const [valPopupShowReassign, setValPopupShowReassign]           = useState(false)
  const [valPopupUserId, setValPopupUserId]                       = useState('')

  // Global validation popup
  const [globalValidationPopup, setGlobalValidationPopup] = useState(false)
  const [globalValNotes, setGlobalValNotes]               = useState('')

  // New step form (inside assessment popup)
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

  function getTaskForm(taskId: string) {
    return taskForms[taskId] ?? { riskLevel: 'low', impactDescription: '', mitigation: '', notes: '' }
  }
  function setTaskForm(taskId: string, patch: Partial<{ riskLevel: string; impactDescription: string; mitigation: string; notes: string }>) {
    setTaskForms((prev) => ({ ...prev, [taskId]: { ...getTaskForm(taskId), ...patch } }))
  }

  return (
    <>
      {/* ── Assessment Tasks ──────────────────────────────────── */}
      {showAssessmentTasks && assessmentTasks.length > 0 && (() => {
        const totalCount     = assessmentTasks.length
        const completedCount = assessmentTasks.filter((t) => ['completed', 'skipped', 'rejected'].includes(t.status)).length
        return (
          <div style={taskCardStyle('assessment', canEditAssessment)}>
            <div onClick={() => onSetAssessmentOpen(!assessmentOpen)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: assessmentOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Assessment Tasks</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {assessmentTasks.map((task) => (
                    <div key={task.id} style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background:
                        task.status === 'completed' ? '#16a34a' :
                        task.status === 'skipped'   ? 'var(--color-slate-light)' :
                        task.status === 'rejected'  ? 'var(--color-trigger-sla-breach)' :
                        '#e5e7eb',
                    }} />
                  ))}
                  <span style={{ fontSize: 12, color: 'var(--color-slate-light)', marginLeft: 2 }}>
                    {completedCount}/{totalCount} completati
                  </span>
                </div>
              </div>
              {assessmentOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
            </div>
            {assessmentOpen && (
              <div style={{ padding: '8px 20px 12px' }}>
                {Object.entries(groupByField(assessmentTasks, (t) => t.assignedTeam?.name ?? 'Non assegnato')).map(([ciType, tasks]) => (
                  <CollapsibleGroup key={ciType} title={ciType.replace(/_/g, ' ')} count={tasks.length}>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                        <thead>
                          <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                            {['CI', 'Team', 'Assegnato a', 'Risk', 'Status'].map((h) => (
                              <th key={h} style={{ textAlign: 'left', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {tasks.map((task) => (
                            <tr
                              key={task.id}
                              onClick={() => setAssessmentTaskPopup(task.id)}
                              style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                            >
                              <td style={{ padding: '8px 12px', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{task.ci?.name ?? '—'}</td>
                              <td style={{ padding: '8px 12px' }}>
                                {task.assignedTeam?.name ?? <span style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 12 }}>Non assegnato</span>}
                              </td>
                              <td style={{ padding: '8px 12px' }}>
                                {task.assignee ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                      {task.assignee.name.charAt(0).toUpperCase()}
                                    </div>
                                    <span style={{ fontSize: 12 }}>{task.assignee.name}</span>
                                  </div>
                                ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                              </td>
                              <td style={{ padding: '8px 12px' }}>
                                {task.riskLevel ? (
                                  <span style={{
                                    fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                                    backgroundColor: task.riskLevel === 'critical' ? 'rgba(239,68,68,0.1)' : task.riskLevel === 'high' ? 'rgba(2,132,199,0.1)' : task.riskLevel === 'medium' ? 'rgba(234,179,8,0.1)' : 'rgba(34,197,94,0.1)',
                                    color: task.riskLevel === 'critical' ? 'var(--color-trigger-sla-breach)' : task.riskLevel === 'high' ? 'var(--color-brand)' : task.riskLevel === 'medium' ? '#ca8a04' : '#16a34a',
                                  }}>{task.riskLevel.toUpperCase()}</span>
                                ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                              </td>
                              <td style={{ padding: '8px 12px' }}><Badge value={task.status} map={TASK_STATUS_COLORS} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CollapsibleGroup>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Validation Tasks ──────────────────────────────────── */}
      {showValidation && (() => {
        const allValItems: { status: string }[] = [
          ...(validationTask ? [validationTask] : []),
          ...deploySteps.filter((s) => s.hasValidation).map((s) => ({ status: s.validationStatus ?? 'pending' })),
        ]
        const totalValCount  = allValItems.length
        const passedValCount = allValItems.filter((v) => v.status === 'passed').length
        const noTasks        = totalValCount === 0
        return (
          <div style={taskCardStyle('validation', canEditValidation)}>
            <div onClick={() => onSetValidationOpen(!validationOpen)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: validationOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Validation Tasks</span>
                {totalValCount > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {allValItems.map((v, i) => (
                      <div key={i} style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: v.status === 'passed' ? '#16a34a' : v.status === 'failed' ? 'var(--color-trigger-sla-breach)' : '#e5e7eb',
                      }} />
                    ))}
                    <span style={{ fontSize: 12, color: 'var(--color-slate-light)', marginLeft: 2 }}>
                      {passedValCount}/{totalValCount} completati
                    </span>
                  </div>
                )}
              </div>
              {validationOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
            </div>
            {validationOpen && noTasks && (
              <div style={{ padding: '16px 20px 20px' }}>
                <div style={{ fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 14, lineHeight: 1.5 }}>
                  Nessun task di validazione definito.<br />
                  Puoi completare la validazione direttamente.
                </div>
                {canEditValidation && (
                  <button
                    onClick={() => { if (instanceId) onExecTransition(instanceId, 'completed', null) }}
                    disabled={transitioning}
                    style={{ padding: '9px 20px', backgroundColor: transitioning ? '#e2e6f0' : 'var(--color-trigger-automatic)', color: transitioning ? 'var(--color-slate-light)' : '#fff', border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: transitioning ? 'not-allowed' : 'pointer' }}
                  >
                    {transitioning ? 'Esecuzione…' : 'Valida e prosegui'}
                  </button>
                )}
              </div>
            )}
            {validationOpen && !noTasks && (
              <div style={{ padding: '0 0 4px' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                        {['Tipo', 'Team', 'Assegnato a', 'Inizio', 'Fine', 'Status'].map((h) => (
                          <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {validationTask && (
                        <tr
                          onClick={() => { setGlobalValidationPopup(true); setGlobalValNotes('') }}
                          style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                        >
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 100, backgroundColor: 'var(--color-slate-bg)', color: 'var(--color-slate)' }}>Globale</span>
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            {validationTask.assignedTeam?.name ?? <span style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 12 }}>Non assegnato</span>}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            {validationTask.assignee ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {validationTask.assignee.name.charAt(0).toUpperCase()}
                                </div>
                                <span style={{ fontSize: 12 }}>{validationTask.assignee.name}</span>
                              </div>
                            ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(validationTask.scheduledStart ?? '')}</td>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(validationTask.scheduledEnd ?? '')}</td>
                          <td style={{ padding: '10px 12px' }}><Badge value={validationTask.status} map={{ ...TASK_STATUS_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} /></td>
                        </tr>
                      )}
                      {deploySteps.filter((s) => s.hasValidation).map((step) => (
                        <tr
                          key={step.id}
                          onClick={() => { setValidationStepPopup(step.id); setValPopupNotes(''); setValPopupShowReassign(false); setValPopupReassignTeamId(''); setValPopupUserId('') }}
                          style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                        >
                          <td style={{ padding: '10px 12px', fontWeight: 500, color: 'var(--color-slate-dark)' }}>Step {step.order}: {step.title}</td>
                          <td style={{ padding: '10px 12px' }}>
                            {step.validationTeam?.name ?? <span style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 12 }}>Non assegnato</span>}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            {step.validationUser ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {step.validationUser.name.charAt(0).toUpperCase()}
                                </div>
                                <span style={{ fontSize: 12 }}>{step.validationUser.name}</span>
                              </div>
                            ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.validationStart ?? '')}</td>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.validationEnd ?? '')}</td>
                          <td style={{ padding: '10px 12px' }}><Badge value={step.validationStatus ?? 'pending'} map={{ ...STATUS_STEP_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Deploy Tasks (readonly table) ─────────────────────── */}
      {showDeploySteps && !deployStepsEditable && (() => {
        const totalDeployCount     = deploySteps.length
        const completedDeployCount = deploySteps.filter((s) => s.status === 'completed').length
        return (
          <div style={taskCardStyle('deploy', canEditDeploy)}>
            <div onClick={() => onSetDeployOpen(!deployOpen)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: deployOpen ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Deploy Tasks</span>
                {totalDeployCount > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {deploySteps.map((s) => (
                      <div key={s.id} style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background:
                          s.status === 'completed' ? '#16a34a' :
                          s.status === 'failed'    ? 'var(--color-trigger-sla-breach)' :
                          s.status === 'skipped'   ? 'var(--color-slate-light)' :
                          '#e5e7eb',
                      }} />
                    ))}
                    <span style={{ fontSize: 12, color: 'var(--color-slate-light)', marginLeft: 2 }}>
                      {completedDeployCount}/{totalDeployCount} completati
                    </span>
                  </div>
                )}
              </div>
              {deployOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
            </div>
            {deployOpen && (
              <div style={{ padding: '8px 20px 12px' }}>
                {deploySteps.length === 0 ? (
                  <div style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>Nessuno step pianificato.</div>
                ) : (
                  Object.entries(groupByField(deploySteps, (s) => s.assignedTeam?.name ?? 'Non assegnato')).map(([status, steps]) => (
                    <CollapsibleGroup key={status} title={status.replace(/_/g, ' ')} count={steps.length}>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                          <thead>
                            <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                              {['Titolo', 'Team', 'Assegnato a', 'Inizio', 'Fine'].map((h) => (
                                <th key={h} style={{ textAlign: 'left', padding: '6px 12px', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {steps.map((step) => (
                              <tr
                                key={step.id}
                                onClick={() => { setDeployStepPopup(step.id); setDeployPopupNotes(''); setDeployPopupShowSkip(false); setDeployPopupSkipReason(''); setDeployPopupShowFail(false); setDeployPopupFailReason(''); setDeployPopupShowReassign(false); setDeployPopupReassignTeamId(''); setDeployPopupUserId('') }}
                                style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                              >
                                <td style={{ padding: '8px 12px', fontWeight: 500, color: 'var(--color-slate-dark)' }}>{step.title}</td>
                                <td style={{ padding: '8px 12px' }}>
                                  {step.assignedTeam?.name ?? <span style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 12 }}>Non assegnato</span>}
                                </td>
                                <td style={{ padding: '8px 12px' }}>
                                  {step.assignee ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        {step.assignee.name.charAt(0).toUpperCase()}
                                      </div>
                                      <span style={{ fontSize: 12 }}>{step.assignee.name}</span>
                                    </div>
                                  ) : <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.scheduledStart ?? '')}</td>
                                <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-slate-light)' }}>{formatDate(step.scheduledEnd ?? '')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CollapsibleGroup>
                  ))
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Reassign Task Dialog ───────────────────────────────── */}
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
                <button
                  onClick={() => setShowAllTeams(true)}
                  style={{ fontSize: 12, color: 'var(--color-brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}
                >
                  Scegli da tutti i team →
                </button>
              )}
              {showAllTeams && <div style={{ marginBottom: 16 }} />}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  onClick={() => { setReassignTaskId(null); setShowAllTeams(false) }}
                  style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
                >
                  Annulla
                </button>
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

      {/* ── Reject Task Dialog ─────────────────────────────────── */}
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
              <button
                onClick={() => setRejectTaskDialog(null)}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
              >
                Annulla
              </button>
              <button
                disabled={rejectTaskReason.trim().length < 10}
                onClick={() => {
                  handlers.onRejectTask(rejectTaskDialog.taskId, rejectTaskReason.trim())
                  setRejectTaskDialog(null)
                  setRejectTaskReason('')
                }}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 500,
                  cursor: rejectTaskReason.trim().length >= 10 ? 'pointer' : 'not-allowed',
                  backgroundColor: rejectTaskReason.trim().length >= 10 ? 'var(--color-trigger-sla-breach)' : '#f3f4f6',
                  color: rejectTaskReason.trim().length >= 10 ? '#fff' : 'var(--color-slate-light)',
                }}
              >
                Conferma rigetto
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Deploy Step Popup Drawer ───────────────────────────── */}
      {deployStepPopup && (() => {
        const step = deploySteps.find((s) => s.id === deployStepPopup)
        if (!step) return null
        const stepDone = ['completed', 'skipped', 'failed'].includes(step.status)
        const canAct = canEditDeploy && !stepDone
        const stepTeamUsers = users.filter((u) => u.teams?.some((t: { id: string }) => t.id === step.assignedTeam?.id))

        return (
          <>
            <div onClick={() => setDeployStepPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Deploy Step</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: 4, marginRight: 8 }}>#{step.order}</span>
                      {step.title}
                    </h2>
                    <Badge value={step.status} map={STATUS_STEP_COLORS} />
                  </div>
                  <button onClick={() => setDeployStepPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: 'var(--color-slate-light)', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {!canEditDeploy && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e6f0', fontSize: 12, color: 'var(--color-slate-light)' }}>
                    Sola lettura — questa fase non è ancora attiva
                  </div>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                  <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--color-slate-light)' }}>{step.id}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Dettagli</div>
                <div style={{ display: 'flex', gap: 24, marginBottom: 20, fontSize: 14 }}>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Inizio</div>
                    <div style={{ fontWeight: 500 }}>{formatDate(step.scheduledStart ?? '')}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Fine</div>
                    <div style={{ fontWeight: 500 }}>{formatDate(step.scheduledEnd ?? '')}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Durata</div>
                    <div style={{ fontWeight: 500 }}>{step.durationDays} {step.durationDays === 1 ? 'giorno' : 'giorni'}</div>
                  </div>
                </div>
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 4 }}>
                  <DetailField
                    label="Rollback Plan"
                    value={step.rollbackPlan}
                    editable={true}
                    onSave={(value) => { void handlers.onUpdateChangeTask(step.id, { rollbackPlan: value }) }}
                  />
                </div>
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Team</div>
                    {deployPopupShowReassign ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={deployPopupReassignTeamId}
                          onChange={(e) => setDeployPopupReassignTeamId(e.target.value)}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Seleziona team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <button
                          disabled={!deployPopupReassignTeamId}
                          onClick={() => {
                            if (deployPopupReassignTeamId) {
                              handlers.onAssignStepTeam(step.id, deployPopupReassignTeamId)
                              setDeployPopupShowReassign(false)
                              setDeployPopupReassignTeamId('')
                              setDeployPopupUserId('')
                            }
                          }}
                          style={{ padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupReassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: deployPopupReassignTeamId ? 'var(--color-brand)' : '#e2e6f0', color: deployPopupReassignTeamId ? '#fff' : 'var(--color-slate-light)' }}
                        >
                          Salva
                        </button>
                        <button onClick={() => setDeployPopupShowReassign(false)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {step.assignedTeam ? (
                          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{step.assignedTeam.name}</span>
                        ) : (
                          <span style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}>Non assegnato</span>
                        )}
                        <button onClick={() => setDeployPopupShowReassign(true)} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Riassegna</button>
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Assegnato a</div>
                    {step.assignedTeam ? (
                      step.assignee ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {step.assignee.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{step.assignee.name}</span>
                          <button onClick={() => setDeployPopupUserId('')} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Cambia</button>
                        </div>
                      ) : (
                        <select
                          value={deployPopupUserId}
                          onChange={(e) => {
                            const userId = e.target.value
                            setDeployPopupUserId(userId)
                            if (userId) handlers.onAssignStepUser(step.id, userId)
                          }}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Assegna utente...</option>
                          {stepTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      )
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>— (assegna prima un team)</span>
                    )}
                  </div>
                </div>
                {canAct && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Azioni</div>
                    {!step.assignedTeam && (
                      <div style={{ fontSize: 12, color: 'var(--color-trigger-sla-breach)', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(220,38,38,0.06)', marginBottom: 12 }}>⚠ Assegna un team allo step per procedere</div>
                    )}
                    {(step.status === 'pending' || step.status === 'in_progress') && (
                      <>
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per completare)</label>
                          <textarea
                            value={deployPopupNotes}
                            onChange={(e) => setDeployPopupNotes(e.target.value)}
                            rows={3}
                            placeholder="Descrivi il risultato del deployment..."
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none' }}
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                          <button
                            disabled={!deployPopupNotes.trim() || !step.assignedTeam || updatingStep}
                            onClick={() => { handlers.onUpdateStepStatus(step.id, 'completed', deployPopupNotes.trim()); setDeployStepPopup(null) }}
                            style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? 'var(--color-trigger-automatic)' : '#e2e6f0', color: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                          >
                            ✓ Completa
                          </button>
                          <button
                            onClick={() => { setDeployPopupShowFail(true); setDeployPopupShowSkip(false) }}
                            style={{ padding: '9px 14px', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', backgroundColor: '#fef2f2', color: 'var(--color-trigger-sla-breach)' }}
                          >
                            Fallito
                          </button>
                          <button
                            onClick={() => { setDeployPopupShowSkip(true); setDeployPopupShowFail(false) }}
                            style={{ padding: '9px 14px', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', backgroundColor: '#f3f4f6', color: 'var(--color-slate)' }}
                          >
                            Salta
                          </button>
                        </div>
                        {deployPopupShowSkip && (
                          <div style={{ padding: 14, borderRadius: 8, border: '1px solid #e2e6f0', backgroundColor: '#fafafa', marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', marginBottom: 8 }}>Motivo del salto (min. 10 caratteri)</div>
                            <textarea
                              value={deployPopupSkipReason}
                              onChange={(e) => setDeployPopupSkipReason(e.target.value)}
                              rows={3}
                              autoFocus
                              placeholder="Es: Step non necessario per questo ambiente..."
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'none', outline: 'none', marginBottom: 8 }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                disabled={deployPopupSkipReason.trim().length < 10 || updatingStep}
                                onClick={() => { handlers.onUpdateStepStatus(step.id, 'skipped', undefined, deployPopupSkipReason.trim()); setDeployStepPopup(null) }}
                                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? 'var(--color-brand)' : '#e2e6f0', color: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                              >
                                Conferma salto
                              </button>
                              <button onClick={() => setDeployPopupShowSkip(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Annulla</button>
                            </div>
                          </div>
                        )}
                        {deployPopupShowFail && (
                          <div style={{ padding: 14, borderRadius: 8, border: '1px solid #fecaca', backgroundColor: 'rgba(254,242,242,0.5)', marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-trigger-sla-breach)', marginBottom: 8 }}>Motivo del fallimento (min. 10 caratteri)</div>
                            <textarea
                              value={deployPopupFailReason}
                              onChange={(e) => setDeployPopupFailReason(e.target.value)}
                              rows={3}
                              autoFocus
                              placeholder="Es: Errore di deploy, rollback eseguito..."
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #fecaca', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'none', outline: 'none', marginBottom: 8 }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                disabled={deployPopupFailReason.trim().length < 10 || updatingStep}
                                onClick={() => { handlers.onUpdateStepStatus(step.id, 'failed', deployPopupFailReason.trim()); setDeployStepPopup(null) }}
                                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupFailReason.trim().length >= 10 && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupFailReason.trim().length >= 10 && !updatingStep ? 'var(--color-trigger-sla-breach)' : '#e2e6f0', color: deployPopupFailReason.trim().length >= 10 && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                              >
                                Conferma fallimento
                              </button>
                              <button onClick={() => setDeployPopupShowFail(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Annulla</button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
                {stepDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {step.skipReason && <div style={{ fontSize: 14, color: 'var(--color-slate)', marginBottom: 8, fontStyle: 'italic' }}>Motivo salto: {step.skipReason}</div>}
                    {step.notes && <div style={{ fontSize: 14, color: 'var(--color-slate-dark)', marginBottom: 8, lineHeight: 1.5 }}>{step.notes}</div>}
                    {step.completedAt && <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Completato il: {new Date(step.completedAt).toLocaleString('it-IT')}</div>}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Validation Step Popup Drawer ───────────────────────── */}
      {validationStepPopup && (() => {
        const step = deploySteps.find((s) => s.id === validationStepPopup)
        if (!step) return null
        const valDone = step.validationStatus === 'passed' || step.validationStatus === 'failed'
        const canAct = canEditValidation && !valDone
        const valTeamUsers = users.filter((u) => u.teams?.some((t: { id: string }) => t.id === step.validationTeam?.id))

        return (
          <>
            <div onClick={() => setValidationStepPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Validazione Step</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>Step {step.order}: {step.title}</h2>
                    <Badge value={step.validationStatus ?? 'pending'} map={{ ...STATUS_STEP_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} />
                  </div>
                  <button onClick={() => setValidationStepPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: 'var(--color-slate-light)', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {!canEditValidation && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e6f0', fontSize: 12, color: 'var(--color-slate-light)' }}>
                    Sola lettura — questa fase non è ancora attiva
                  </div>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                  <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--color-slate-light)' }}>{step.id}</div>
                </div>
                {step.validationStart && step.validationEnd && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Finestra di Validazione</div>
                    <div style={{ display: 'flex', gap: 24, fontSize: 14 }}>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Inizio</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(step.validationStart)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Fine</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(step.validationEnd)}</div>
                      </div>
                    </div>
                  </div>
                )}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Team Validazione</div>
                    {valPopupShowReassign ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={valPopupReassignTeamId}
                          onChange={(e) => setValPopupReassignTeamId(e.target.value)}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Seleziona team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <button
                          disabled={!valPopupReassignTeamId}
                          onClick={() => {
                            if (valPopupReassignTeamId) {
                              handlers.onAssignValidationTeam(step.id, valPopupReassignTeamId)
                              setValPopupShowReassign(false)
                              setValPopupReassignTeamId('')
                              setValPopupUserId('')
                            }
                          }}
                          style={{ padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: valPopupReassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: valPopupReassignTeamId ? 'var(--color-brand)' : '#e2e6f0', color: valPopupReassignTeamId ? '#fff' : 'var(--color-slate-light)' }}
                        >
                          Salva
                        </button>
                        <button onClick={() => setValPopupShowReassign(false)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {step.validationTeam ? (
                          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{step.validationTeam.name}</span>
                        ) : (
                          <span style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}>Non assegnato</span>
                        )}
                        {!valDone && <button onClick={() => setValPopupShowReassign(true)} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Riassegna</button>}
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Responsabile Validazione</div>
                    {step.validationTeam ? (
                      step.validationUser ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {step.validationUser.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{step.validationUser.name}</span>
                          {!valDone && <button onClick={() => setValPopupUserId('')} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Cambia</button>}
                        </div>
                      ) : (
                        <select
                          value={valPopupUserId}
                          onChange={(e) => {
                            const userId = e.target.value
                            setValPopupUserId(userId)
                            if (userId) handlers.onAssignValidationUser(step.id, userId)
                          }}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Assegna responsabile...</option>
                          {valTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      )
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>— (assegna prima un team)</span>
                    )}
                  </div>
                </div>
                {canAct && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Azioni</div>
                    {!step.validationTeam && (
                      <div style={{ fontSize: 12, color: 'var(--color-trigger-sla-breach)', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(220,38,38,0.06)', marginBottom: 12 }}>⚠ Assegna un team di validazione per procedere</div>
                    )}
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per fallimento)</label>
                      <textarea
                        value={valPopupNotes}
                        onChange={(e) => setValPopupNotes(e.target.value)}
                        rows={3}
                        placeholder="Note della validazione..."
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none' }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        disabled={!step.validationTeam || updatingStep}
                        onClick={() => { handlers.onUpdateStepValidation(step.id, 'passed', valPopupNotes || null); setValidationStepPopup(null) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: step.validationTeam && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: step.validationTeam && !updatingStep ? 'var(--color-trigger-automatic)' : '#e2e6f0', color: step.validationTeam && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                      >
                        ✓ Passa
                      </button>
                      <button
                        disabled={!step.validationTeam || !valPopupNotes.trim() || updatingStep}
                        onClick={() => { handlers.onUpdateStepValidation(step.id, 'failed', valPopupNotes.trim()); setValidationStepPopup(null) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: step.validationTeam && valPopupNotes.trim() && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: step.validationTeam && valPopupNotes.trim() && !updatingStep ? 'var(--color-trigger-sla-breach)' : '#e2e6f0', color: step.validationTeam && valPopupNotes.trim() && !updatingStep ? '#fff' : 'var(--color-slate-light)' }}
                      >
                        ✗ Fallisce
                      </button>
                    </div>
                  </div>
                )}
                {valDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {step.validationNotes && <div style={{ fontSize: 14, color: 'var(--color-slate-dark)', marginBottom: 8, lineHeight: 1.5 }}>{step.validationNotes}</div>}
                    {step.completedAt && <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Completato il: {new Date(step.completedAt).toLocaleString('it-IT')}</div>}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Global Validation Popup Drawer ────────────────────── */}
      {globalValidationPopup && validationTask && (() => {
        const val = validationTask
        const valDone = val.status === 'passed' || val.status === 'failed'
        const canAct  = canEditValidation && !valDone
        return (
          <>
            <div onClick={() => setGlobalValidationPopup(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Validazione</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>Validazione Globale</h2>
                    <Badge value={val.status} map={{ ...TASK_STATUS_COLORS, passed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' }, failed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' } }} />
                  </div>
                  <button onClick={() => setGlobalValidationPopup(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: 'var(--color-slate-light)', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {!canEditValidation && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e6f0', fontSize: 12, color: 'var(--color-slate-light)' }}>
                    Sola lettura — questa fase non è ancora attiva
                  </div>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                  <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--color-slate-light)' }}>{val.id}</div>
                </div>
                {val.scheduledStart && val.scheduledEnd && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Finestra di Validazione</div>
                    <div style={{ display: 'flex', gap: 24, fontSize: 14 }}>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Inizio</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(val.scheduledStart)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginBottom: 2 }}>Fine</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(val.scheduledEnd)}</div>
                      </div>
                    </div>
                  </div>
                )}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 4 }}>Team</div>
                    {val.assignedTeam ? (
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{val.assignedTeam.name}</span>
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}>Non assegnato</span>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 4 }}>Responsabile</div>
                    {val.assignee ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {val.assignee.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{val.assignee.name}</span>
                      </div>
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>—</span>
                    )}
                  </div>
                </div>
                {canAct && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Azioni</div>
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per fallimento)</label>
                      <textarea
                        value={globalValNotes}
                        onChange={(e) => setGlobalValNotes(e.target.value)}
                        rows={3}
                        placeholder="Note della validazione..."
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none' }}
                      />
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => { handlers.onCompleteValidation(changeId, globalValNotes || null); setGlobalValidationPopup(false) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', backgroundColor: 'var(--color-trigger-automatic)', color: '#fff' }}
                      >
                        ✓ Passa
                      </button>
                      <button
                        disabled={!globalValNotes.trim()}
                        onClick={() => { handlers.onFailValidation(changeId); setGlobalValidationPopup(false) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: globalValNotes.trim() ? 'pointer' : 'not-allowed', backgroundColor: globalValNotes.trim() ? 'var(--color-trigger-sla-breach)' : '#e2e6f0', color: globalValNotes.trim() ? '#fff' : 'var(--color-slate-light)' }}
                      >
                        ✗ Fallisce
                      </button>
                    </div>
                  </div>
                )}
                {valDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {val.notes && <div style={{ fontSize: 14, color: 'var(--color-slate-dark)', marginBottom: 8, lineHeight: 1.5 }}>{val.notes}</div>}
                    {val.completedAt && <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Completato il: {new Date(val.completedAt).toLocaleString('it-IT')}</div>}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* ── Assessment Task Popup Drawer ───────────────────────── */}
      {assessmentTaskPopup && (() => {
        const task = assessmentTasks.find((t) => t.id === assessmentTaskPopup)
        if (!task) return null
        const taskForm = getTaskForm(task.id)
        const isEditable = task.status === 'open' && canEditAssessment
        const isDone = ['completed', 'rejected'].includes(task.status)
        const taskTeamUsers = users.filter((u) => u.teams?.some((t: { id: string }) => t.id === task.assignedTeam?.id))

        return (
          <>
            <div onClick={() => setAssessmentTaskPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 560, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Assessment Task</div>
                    <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>{task.ci?.name ?? '—'}</h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {task.ci?.type && <span style={{ fontSize: 12, color: 'var(--color-slate-light)', backgroundColor: '#f3f4f6', padding: '2px 8px', borderRadius: 4 }}>{task.ci.type}</span>}
                      {task.ci?.environment && <span style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>{task.ci.environment}</span>}
                      <Badge value={task.status} map={TASK_STATUS_COLORS} />
                    </div>
                  </div>
                  <button onClick={() => setAssessmentTaskPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 24, color: 'var(--color-slate-light)', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {!canEditAssessment && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 6, backgroundColor: '#f8fafc', border: '1px solid #e2e6f0', fontSize: 12, color: 'var(--color-slate-light)' }}>
                    Sola lettura — questa fase non è ancora attiva
                  </div>
                )}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>ID</div>
                  <div style={{ fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--color-slate-light)' }}>{task.id}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Assessment</div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Team</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {task.assignedTeam ? (
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{task.assignedTeam.name}</span>
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-trigger-sla-breach)' }}>Non assegnato</span>
                    )}
                    {isEditable && (
                      <button
                        onClick={() => { setReassignTaskId(task.id); setReassignTeamId(''); setAssessmentTaskPopup(null) }}
                        style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}
                      >
                        Riassegna
                      </button>
                    )}
                  </div>
                </div>
                {isEditable && task.assignedTeam && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Assegnato a</div>
                    {task.assignee ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {task.assignee.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{task.assignee.name}</span>
                        <button
                          onClick={() => setAssignTaskUserId((prev) => ({ ...prev, [task.id]: '' }))}
                          style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}
                        >
                          Cambia
                        </button>
                      </div>
                    ) : (
                      <select
                        value={assignTaskUserId[task.id] ?? ''}
                        onChange={(e) => {
                          const userId = e.target.value
                          setAssignTaskUserId((prev) => ({ ...prev, [task.id]: userId }))
                          if (userId) handlers.onAssignTaskUser(task.id, userId)
                        }}
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                      >
                        <option value="">Assegna utente...</option>
                        {taskTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    )}
                  </div>
                )}
                {isDone && task.assignee && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Assegnato a</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {task.assignee.name.charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{task.assignee.name}</span>
                    </div>
                  </div>
                )}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Risk Level</div>
                  {isEditable ? (
                    <select value={taskForm.riskLevel} onChange={(e) => setTaskForm(task.id, { riskLevel: e.target.value })} style={inputStyle}>
                      {['low', 'medium', 'high', 'critical'].map((r) => (
                        <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ fontSize: 14, color: 'var(--color-slate-dark)' }}>{task.riskLevel ?? '—'}</span>
                  )}
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Descrizione impatto</div>
                  {isEditable ? (
                    <textarea value={taskForm.impactDescription} onChange={(e) => setTaskForm(task.id, { impactDescription: e.target.value })} rows={3} style={textareaStyle} placeholder="Descrivi l'impatto del change su questo CI..." />
                  ) : (
                    <p style={{ fontSize: 14, color: 'var(--color-slate-dark)', margin: 0, lineHeight: 1.5 }}>{task.impactDescription ?? '—'}</p>
                  )}
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Mitigazione</div>
                  {isEditable ? (
                    <textarea value={taskForm.mitigation} onChange={(e) => setTaskForm(task.id, { mitigation: e.target.value })} rows={2} style={textareaStyle} placeholder="Piano di mitigazione..." />
                  ) : (
                    <p style={{ fontSize: 14, color: 'var(--color-slate-dark)', margin: 0, lineHeight: 1.5 }}>{task.mitigation ?? '—'}</p>
                  )}
                </div>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', marginBottom: 6 }}>Note</div>
                  {isEditable ? (
                    <textarea value={taskForm.notes} onChange={(e) => setTaskForm(task.id, { notes: e.target.value })} rows={2} style={textareaStyle} placeholder="Note aggiuntive..." />
                  ) : (
                    <p style={{ fontSize: 14, color: 'var(--color-slate-dark)', margin: 0, lineHeight: 1.5 }}>{task.notes ?? '—'}</p>
                  )}
                </div>
                {isEditable && (
                  <div style={{ marginBottom: 24 }}>
                    {!task.assignedTeam && (
                      <div style={{ fontSize: 12, color: 'var(--color-trigger-sla-breach)', marginBottom: 8 }}>⚠ Assegna un team prima di completare</div>
                    )}
                    {task.assignedTeam && (
                      <>
                        {deploySteps.length === 0 && (
                          <div style={{ fontSize: 12, color: '#ca8a04', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(234,179,8,0.08)', marginBottom: 8 }}>
                            ⚠ Aggiungi almeno uno step di deployment prima di completare il task
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => {
                              handlers.onCompleteTask(task.id, { riskLevel: taskForm.riskLevel, impactDescription: taskForm.impactDescription, mitigation: taskForm.mitigation || null, notes: taskForm.notes || null })
                              setAssessmentTaskPopup(null)
                            }}
                            disabled={completingTask || !taskForm.impactDescription.trim() || !taskForm.riskLevel || deploySteps.length === 0}
                            style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: taskForm.impactDescription.trim() && taskForm.riskLevel && deploySteps.length > 0 && !completingTask ? 'pointer' : 'not-allowed', backgroundColor: taskForm.impactDescription.trim() && taskForm.riskLevel && deploySteps.length > 0 && !completingTask ? 'var(--color-trigger-automatic)' : '#e2e6f0', color: taskForm.impactDescription.trim() && taskForm.riskLevel && deploySteps.length > 0 && !completingTask ? '#fff' : 'var(--color-slate-light)' }}
                          >
                            {completingTask ? 'Completamento…' : '✓ Completa task'}
                          </button>
                          <button
                            onClick={() => { setRejectTaskDialog({ taskId: task.id, ciName: task.ci?.name ?? '—' }); setAssessmentTaskPopup(null) }}
                            disabled={rejectingTask}
                            style={{ padding: '9px 16px', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer', backgroundColor: '#fef2f2', color: 'var(--color-trigger-sla-breach)' }}
                          >
                            Rigetta
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Piano di Deployment */}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 20, marginTop: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                    <div style={{ flex: 1, height: 1, backgroundColor: '#e2e6f0' }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>Piano di Deployment</span>
                    <div style={{ flex: 1, height: 1, backgroundColor: '#e2e6f0' }} />
                  </div>
                  {deploySteps.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                      {deploySteps.map((step) => (
                        <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', backgroundColor: '#f8f9fc', borderRadius: 7 }}>
                          <span style={{ backgroundColor: 'var(--color-brand)', color: '#fff', width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{step.order}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-slate-dark)' }}>{step.title}</div>
                            <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>
                              {formatDate(step.scheduledStart ?? '')} → {formatDate(step.scheduledEnd ?? '')}
                              {step.assignedTeam && <span style={{ marginLeft: 8 }}>· {step.assignedTeam.name}</span>}
                            </div>
                          </div>
                          <Badge value={step.status} map={STATUS_STEP_COLORS} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 14 }}>Nessuno step pianificato.</p>
                  )}
                  {deployStepsEditable && (
                    <div style={{ marginTop: 8, padding: 16, borderRadius: 8, border: '1px dashed #e2e6f0', backgroundColor: '#fafafa' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Aggiungi step</div>
                      <input
                        placeholder="Titolo step *"
                        value={newStepForm.title}
                        onChange={(e) => setNewStepForm((p) => ({ ...p, title: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, marginBottom: 8, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", outline: 'none' }}
                      />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                        <div>
                          <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>DATA INIZIO *</label>
                          <input
                            type="date"
                            value={newStepForm.scheduledStart}
                            onChange={(e) => {
                              const start = e.target.value
                              setNewStepForm((p) => ({ ...p, scheduledStart: start, scheduledEnd: calcEnd(start, p.durationDays) }))
                            }}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>DURATA (GG) *</label>
                          <input
                            type="number"
                            min={1}
                            value={newStepForm.durationDays}
                            onChange={(e) => {
                              const days = parseInt(e.target.value) || 1
                              setNewStepForm((p) => ({ ...p, durationDays: days, scheduledEnd: calcEnd(p.scheduledStart, days) }))
                            }}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>FINE PREVISTA</label>
                          <input
                            readOnly
                            value={newStepForm.scheduledEnd}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, backgroundColor: '#f3f4f6', color: 'var(--color-slate-light)' }}
                          />
                        </div>
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>TEAM DEPLOY</label>
                        <select
                          value={newStepForm.assignedTeamId}
                          onChange={(e) => setNewStepForm((p) => ({ ...p, assignedTeamId: e.target.value }))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                        >
                          <option value="">Default (Support Group)</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: newStepForm.hasValidation ? 8 : 0 }}>
                        <input
                          type="checkbox"
                          id="popupHasValidation"
                          checked={newStepForm.hasValidation}
                          onChange={(e) => setNewStepForm((p) => ({ ...p, hasValidation: e.target.checked }))}
                        />
                        <label htmlFor="popupHasValidation" style={{ fontSize: 14, cursor: 'pointer' }}>Ha finestra di validazione propria</label>
                      </div>
                      {newStepForm.hasValidation && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8, marginTop: 8 }}>
                          <div>
                            <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>INIZIO VALIDAZIONE *</label>
                            <input type="date" value={newStepForm.validationStart} onChange={(e) => setNewStepForm((p) => ({ ...p, validationStart: e.target.value }))} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>FINE VALIDAZIONE *</label>
                            <input type="date" value={newStepForm.validationEnd} onChange={(e) => setNewStepForm((p) => ({ ...p, validationEnd: e.target.value }))} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }} />
                          </div>
                          <div style={{ gridColumn: '1/-1' }}>
                            <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>TEAM VALIDAZIONE</label>
                            <select
                              value={newStepForm.validationTeamId}
                              onChange={(e) => setNewStepForm((p) => ({ ...p, validationTeamId: e.target.value }))}
                              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}
                            >
                              <option value="">Default (Owner Group)</option>
                              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          </div>
                        </div>
                      )}
                      <button
                        disabled={!newStepForm.title.trim() || !newStepForm.scheduledStart || savingSteps}
                        onClick={() => {
                          const existingSteps = deploySteps.map((s) => ({
                            order: s.order, title: s.title, description: s.description ?? null,
                            scheduledStart: s.scheduledStart, durationDays: s.durationDays,
                            hasValidation: s.hasValidation,
                            validationStart: s.validationStart ?? null, validationEnd: s.validationEnd ?? null,
                            assignedTeamId: s.assignedTeam?.id ?? null,
                          }))
                          handlers.onSaveSteps(changeId, [...existingSteps, {
                            order: deploySteps.length + 1,
                            title: newStepForm.title.trim(),
                            description: null,
                            scheduledStart: newStepForm.scheduledStart,
                            durationDays: newStepForm.durationDays,
                            hasValidation: newStepForm.hasValidation,
                            validationStart: newStepForm.hasValidation ? newStepForm.validationStart || null : null,
                            validationEnd: newStepForm.hasValidation ? newStepForm.validationEnd || null : null,
                            assignedTeamId: newStepForm.assignedTeamId || null,
                          }])
                          setNewStepForm({
                            title: '', scheduledStart: new Date().toISOString().split('T')[0] ?? '',
                            durationDays: 1, scheduledEnd: '', hasValidation: false,
                            validationStart: '', validationEnd: '', assignedTeamId: '', validationTeamId: '',
                          })
                        }}
                        style={{ marginTop: 12, width: '100%', padding: '8px', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 500, cursor: newStepForm.title.trim() && newStepForm.scheduledStart && !savingSteps ? 'pointer' : 'not-allowed', backgroundColor: newStepForm.title.trim() && newStepForm.scheduledStart && !savingSteps ? 'var(--color-brand)' : '#e2e6f0', color: newStepForm.title.trim() && newStepForm.scheduledStart && !savingSteps ? '#fff' : 'var(--color-slate-light)' }}
                      >
                        {savingSteps ? 'Salvataggio…' : '+ Aggiungi step'}
                      </button>
                    </div>
                  )}
                  {deployStepsEditable && deploySteps.length > 0 && !deploySteps.some((s) => s.hasValidation) && (
                    <div style={{ marginTop: 16, padding: 16, borderRadius: 8, border: '1px solid #fde68a', backgroundColor: 'rgba(234,179,8,0.05)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#ca8a04', marginBottom: 12 }}>
                        ⚠ Nessuno step ha validazione propria — definisci la finestra di validazione globale
                      </div>
                      {validationTask ? (
                        <div style={{ fontSize: 14, color: 'var(--color-slate)' }}>
                          Pianificata: {formatDate(validationTask.scheduledStart ?? '')} → {formatDate(validationTask.scheduledEnd ?? '')}
                          {' '}<Badge value={validationTask.status} map={TASK_STATUS_COLORS} />
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                            <div>
                              <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>INIZIO VALIDAZIONE *</label>
                              <input type="date" value={globalValidationStart} onChange={(e) => setGlobalValidationStart(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }} />
                            </div>
                            <div>
                              <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>FINE VALIDAZIONE *</label>
                              <input type="date" value={globalValidationEnd} onChange={(e) => setGlobalValidationEnd(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }} />
                            </div>
                          </div>
                          <button
                            disabled={!globalValidationStart || !globalValidationEnd || savingValidation}
                            onClick={() => handlers.onSaveValidation(changeId, globalValidationStart, globalValidationEnd)}
                            style={{ width: '100%', padding: '8px', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 500, cursor: globalValidationStart && globalValidationEnd && !savingValidation ? 'pointer' : 'not-allowed', backgroundColor: globalValidationStart && globalValidationEnd && !savingValidation ? 'var(--color-brand)' : '#e2e6f0', color: globalValidationStart && globalValidationEnd && !savingValidation ? '#fff' : 'var(--color-slate-light)' }}
                          >
                            {savingValidation ? 'Salvataggio…' : 'Salva validazione globale'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )
      })()}
    </>
  )
}
