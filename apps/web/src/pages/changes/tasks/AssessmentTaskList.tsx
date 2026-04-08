import { ChevronDown, ChevronRight } from 'lucide-react'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
import { useEnumValues } from '@/hooks/useEnumValues'
import type { Team, User, ChangeTask } from '../change-types'
import { Badge, TASK_STATUS_COLORS, STATUS_STEP_COLORS, formatDate, groupByField, cardStyle, inputStyle, textareaStyle } from '../change-types'
import type { TaskHandlers } from './types'

interface AssessmentTaskListProps {
  changeId: string
  assessmentTasks: ChangeTask[]
  deploySteps: ChangeTask[]
  validationTask: ChangeTask | null
  teams: Team[]
  users: User[]
  canEditAssessment: boolean
  deployStepsEditable: boolean
  assessmentOpen: boolean
  onSetAssessmentOpen: (v: boolean) => void
  completingTask: boolean
  rejectingTask: boolean
  savingSteps: boolean
  savingValidation: boolean
  // Popup state (controlled from parent)
  assessmentTaskPopup: string | null
  setAssessmentTaskPopup: (id: string | null) => void
  taskForms: Record<string, { riskLevel: string; impactDescription: string; mitigation: string; notes: string }>
  setTaskForm: (taskId: string, patch: Partial<{ riskLevel: string; impactDescription: string; mitigation: string; notes: string }>) => void
  assignTaskUserId: Record<string, string>
  setAssignTaskUserId: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setReassignTaskId: (id: string | null) => void
  setReassignTeamId: (id: string) => void
  setRejectTaskDialog: (v: { taskId: string; ciName: string } | null) => void
  newStepForm: {
    title: string; scheduledStart: string; durationDays: number; scheduledEnd: string
    hasValidation: boolean; validationStart: string; validationEnd: string; assignedTeamId: string; validationTeamId: string
  }
  setNewStepForm: React.Dispatch<React.SetStateAction<{
    title: string; scheduledStart: string; durationDays: number; scheduledEnd: string
    hasValidation: boolean; validationStart: string; validationEnd: string; assignedTeamId: string; validationTeamId: string
  }>>
  globalValidationStart: string
  setGlobalValidationStart: (v: string) => void
  globalValidationEnd: string
  setGlobalValidationEnd: (v: string) => void
  calcEnd: (start: string, days: number) => string
  handlers: TaskHandlers
}

export function AssessmentTaskList({
  changeId,
  assessmentTasks,
  deploySteps,
  validationTask,
  teams,
  users,
  canEditAssessment,
  deployStepsEditable,
  assessmentOpen,
  onSetAssessmentOpen,
  completingTask,
  rejectingTask,
  savingSteps,
  savingValidation,
  assessmentTaskPopup,
  setAssessmentTaskPopup,
  taskForms,
  setTaskForm,
  assignTaskUserId,
  setAssignTaskUserId,
  setReassignTaskId,
  setReassignTeamId,
  setRejectTaskDialog,
  newStepForm,
  setNewStepForm,
  globalValidationStart,
  setGlobalValidationStart,
  globalValidationEnd,
  setGlobalValidationEnd,
  calcEnd,
  handlers,
}: AssessmentTaskListProps) {
  const totalCount     = assessmentTasks.length
  const completedCount = assessmentTasks.filter((t) => ['completed', 'skipped', 'rejected'].includes(t.status)).length

  const { values: RISK_LEVELS } = useEnumValues('change', 'risk')
  const riskOptions = RISK_LEVELS.length > 0 ? RISK_LEVELS : ['low', 'medium', 'high', 'critical']

  function getTaskForm(taskId: string) {
    return taskForms[taskId] ?? { riskLevel: 'low', impactDescription: '', mitigation: '', notes: '' }
  }

  return (
    <div style={{ ...cardStyle, borderLeft: canEditAssessment ? '4px solid var(--color-brand)' : '4px solid #e5e7eb', borderRadius: '0 10px 10px 0', background: canEditAssessment ? '#fff' : '#fafafa', padding: 0, transition: 'all 0.2s' }}>
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

      {/* Assessment Task Popup Drawer */}
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
                        <button onClick={() => setAssignTaskUserId((prev) => ({ ...prev, [task.id]: '' }))} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}>Cambia</button>
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
                      {riskOptions.map((r) => (
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
                          <input type="date" value={newStepForm.scheduledStart}
                            onChange={(e) => {
                              const start = e.target.value
                              setNewStepForm((p) => ({ ...p, scheduledStart: start, scheduledEnd: calcEnd(start, p.durationDays) }))
                            }}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>DURATA (GG) *</label>
                          <input type="number" min={1} value={newStepForm.durationDays}
                            onChange={(e) => {
                              const days = parseInt(e.target.value) || 1
                              setNewStepForm((p) => ({ ...p, durationDays: days, scheduledEnd: calcEnd(p.scheduledStart, days) }))
                            }}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>FINE PREVISTA</label>
                          <input readOnly value={newStepForm.scheduledEnd}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, backgroundColor: '#f3f4f6', color: 'var(--color-slate-light)' }} />
                        </div>
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'block', marginBottom: 4 }}>TEAM DEPLOY</label>
                        <select value={newStepForm.assignedTeamId} onChange={(e) => setNewStepForm((p) => ({ ...p, assignedTeamId: e.target.value }))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}>
                          <option value="">Default (Support Group)</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: newStepForm.hasValidation ? 8 : 0 }}>
                        <input type="checkbox" id="popupHasValidation" checked={newStepForm.hasValidation}
                          onChange={(e) => setNewStepForm((p) => ({ ...p, hasValidation: e.target.checked }))} />
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
                            <select value={newStepForm.validationTeamId} onChange={(e) => setNewStepForm((p) => ({ ...p, validationTeamId: e.target.value }))}
                              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, outline: 'none' }}>
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
    </div>
  )
}
