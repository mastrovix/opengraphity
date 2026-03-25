import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  GET_CHANGE, GET_TEAMS, GET_USERS,
} from '@/graphql/queries'
import {
  EXECUTE_CHANGE_TRANSITION,
  COMPLETE_ASSESSMENT_TASK,
  REJECT_ASSESSMENT_TASK,
  SAVE_DEPLOY_STEPS,
  SAVE_CHANGE_VALIDATION,
  UPDATE_DEPLOY_STEP_STATUS,
  ADD_AFFECTED_CI_TO_CHANGE,
  REMOVE_AFFECTED_CI_FROM_CHANGE,
  COMPLETE_CHANGE_VALIDATION,
  FAIL_CHANGE_VALIDATION,
  ASSIGN_ASSESSMENT_TASK_TEAM,
  ASSIGN_ASSESSMENT_TASK_USER,
  ADD_CHANGE_COMMENT,
  UPDATE_DEPLOY_STEP_VALIDATION,
  ASSIGN_DEPLOY_STEP_TO_TEAM,
  ASSIGN_DEPLOY_STEP_TO_USER,
  ASSIGN_DEPLOY_STEP_VALIDATION_TEAM,
  ASSIGN_DEPLOY_STEP_VALIDATION_USER,
  UPDATE_CHANGE_TASK,
} from '@/graphql/mutations'
import { CountBadge } from '@/components/ui/CountBadge'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Change, Team, User, WorkflowTransition } from './change-types'
import { Badge, STEP_COLORS, cardStyle, textareaStyle } from './change-types'
import { ChangeHeader } from './ChangeHeader'
import { ChangeDetails } from './ChangeDetails'
import { ChangeImpact } from './ChangeImpact'
import { ChangeCIList } from './ChangeCIList'
import { ChangeComments } from './ChangeComments'
import { ChangeTasks } from './ChangeTasks'

export function ChangeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, loading, refetch } = useQuery<{ change: Change | null }>(GET_CHANGE, {
    variables: { id },
    fetchPolicy: 'cache-and-network',
  })

  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS)
  const { data: usersData } = useQuery<{ users: User[] }>(GET_USERS)

  // Transition dialog state
  const [pendingTransition, setPendingTransition] = useState<WorkflowTransition | null>(null)
  const [transitionNotes, setTransitionNotes]     = useState('')
  const [isTransitionOpen, setIsTransitionOpen]   = useState(false)

  // Remove CI dialog state
  const [removeCIDialog, setRemoveCIDialog]   = useState<{ ciId: string; ciName: string } | null>(null)
  const [removeCIReason, setRemoveCIReason]   = useState('')

  // Task section open state (controlled here so useEffect can set them)
  const [assessmentOpen, setAssessmentOpen] = useState(false)
  const [deployOpen,     setDeployOpen]     = useState(false)
  const [validationOpen, setValidationOpen] = useState(false)

  // Related incidents open state
  const [incidentsOpen, setIncidentsOpen] = useState(true)

  useEffect(() => {
    const step = data?.change?.workflowInstance?.currentStep ?? ''
    setAssessmentOpen(step === 'assessment')
    setDeployOpen(['scheduled', 'deployment'].includes(step))
    setValidationOpen(step === 'validation')
  }, [data?.change?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ─────────────────────────────────────────────

  const [execTransition, { loading: transitioning }] = useMutation<{
    executeChangeTransition: { success: boolean; error: string | null; instance: { id: string; currentStep: string; status: string } }
  }>(EXECUTE_CHANGE_TRANSITION, {
    onCompleted: (d) => {
      if (d.executeChangeTransition.success) {
        toast.success('Transizione eseguita')
        setIsTransitionOpen(false)
        setTransitionNotes('')
        setPendingTransition(null)
        void refetch()
      } else {
        toast.error(d.executeChangeTransition.error ?? 'Errore transizione')
      }
    },
    onError: (e) => toast.error(e.message),
  })

  const [completeTask, { loading: completingTask }] = useMutation(COMPLETE_ASSESSMENT_TASK, {
    onCompleted: () => { toast.success('Task completato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [rejectTask, { loading: rejectingTask }] = useMutation(REJECT_ASSESSMENT_TASK, {
    onCompleted: () => { toast.success('Task rigettato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [saveSteps, { loading: savingSteps }] = useMutation(SAVE_DEPLOY_STEPS, {
    onCompleted: () => { toast.success('Deploy steps salvati'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [saveValidation, { loading: savingValidation }] = useMutation(SAVE_CHANGE_VALIDATION, {
    onCompleted: () => { toast.success('Validazione salvata'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [updateStepStatus, { loading: updatingStep }] = useMutation(UPDATE_DEPLOY_STEP_STATUS, {
    onCompleted: () => { toast.success('Stato step aggiornato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [updateStepValidation] = useMutation(UPDATE_DEPLOY_STEP_VALIDATION, {
    onCompleted: () => { toast.success('Validazione aggiornata'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [assignTaskTeam] = useMutation(ASSIGN_ASSESSMENT_TASK_TEAM, {
    onCompleted: () => { toast.success('Team riassegnato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [assignTaskUser] = useMutation(ASSIGN_ASSESSMENT_TASK_USER, {
    onCompleted: () => { toast.success('Utente assegnato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [completeValidation] = useMutation(COMPLETE_CHANGE_VALIDATION, {
    onCompleted: () => { toast.success('Validazione completata'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [failValidation] = useMutation(FAIL_CHANGE_VALIDATION, {
    onCompleted: () => { toast.success('Validazione fallita'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [addCI] = useMutation(ADD_AFFECTED_CI_TO_CHANGE, {
    onCompleted: () => { toast.success('CI aggiunto'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [removeCI] = useMutation(REMOVE_AFFECTED_CI_FROM_CHANGE, {
    onCompleted: () => { toast.success('CI rimosso'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [addComment, { loading: addingComment }] = useMutation(ADD_CHANGE_COMMENT, {
    onCompleted: () => { toast.success('Commento aggiunto'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [assignStepTeam] = useMutation(ASSIGN_DEPLOY_STEP_TO_TEAM, {
    onCompleted: () => { toast.success('Team step aggiornato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [assignStepUser] = useMutation(ASSIGN_DEPLOY_STEP_TO_USER, {
    onCompleted: () => { toast.success('Assegnatario step aggiornato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [assignValidationTeam] = useMutation(ASSIGN_DEPLOY_STEP_VALIDATION_TEAM, {
    onCompleted: () => { toast.success('Team validazione aggiornato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [assignValidationUser] = useMutation(ASSIGN_DEPLOY_STEP_VALIDATION_USER, {
    onCompleted: () => { toast.success('Responsabile validazione aggiornato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [updateChangeTask] = useMutation(UPDATE_CHANGE_TASK, {
    onCompleted: () => { toast.success('Task aggiornato'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  // ── Derived data ──────────────────────────────────────────

  const teams = teamsData?.teams ?? []
  const users = usersData?.users ?? []

  if (loading) return <div style={{ color: 'var(--color-slate-light)', fontSize: 14, padding: 40 }}>Caricamento…</div>
  if (!data?.change) return <div style={{ color: 'var(--color-slate-light)', fontSize: 14, padding: 40 }}>Change non trovato.</div>

  const change     = data.change
  const deploySteps     = (change.changeTasks ?? []).filter((t) => t.taskType === 'deploy')
  const assessmentTasks = (change.changeTasks ?? []).filter((t) => t.taskType === 'assessment')
  const validationTask  = (change.changeTasks ?? []).find((t) => t.taskType === 'validation') ?? null
  const currentStep = change.workflowInstance?.currentStep ?? ''
  const instanceId  = change.workflowInstance?.id ?? ''

  // ── Handlers for transitions ──────────────────────────────

  function handleTransition(tr: WorkflowTransition) {
    if (!tr.requiresInput) {
      if (instanceId) execTransition({ variables: { instanceId, toStep: tr.toStep, notes: null } })
    } else {
      setPendingTransition(tr); setTransitionNotes(''); setIsTransitionOpen(true)
    }
  }

  // ── Render ────────────────────────────────────────────────

  return (
    <div>
      <button
        onClick={() => navigate('/changes')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand)', fontSize: 14, padding: 0, marginBottom: 16 }}
      >
        ← Torna ai Changes
      </button>

      <ChangeHeader
        change={change}
        currentStep={currentStep}
        instanceId={instanceId}
        transitioning={transitioning}
        onTransition={handleTransition}
      />

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>

        {/* Left column */}
        <div style={{ flex: 1, minWidth: 0 }}>

          <ChangeImpact
            impactAnalysis={change.impactAnalysis}
            hasCIs={change.affectedCIs.length > 0}
          />

          <ChangeDetails change={change} currentStep={currentStep} />

          <ChangeCIList
            changeId={change.id}
            affectedCIs={change.affectedCIs}
            currentStep={currentStep}
            onAddCI={(ciId) => addCI({ variables: { changeId: change.id, ciId } })}
            onRemoveCI={(ciId, ciName) => { setRemoveCIDialog({ ciId, ciName }); setRemoveCIReason('') }}
          />

          {/* Related Incidents */}
          {change.relatedIncidents.length > 0 && (
            <div style={{ ...cardStyle, padding: 0 }}>
              <div onClick={() => setIncidentsOpen((p) => !p)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: incidentsOpen ? '1px solid #e5e7eb' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Incident Correlati</span>
                  <CountBadge count={change.relatedIncidents.length} />
                </div>
                {incidentsOpen ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
              </div>
              {incidentsOpen && (
                <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {change.relatedIncidents.map((inc) => (
                    <div key={inc.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', backgroundColor: '#f8f9fc', borderRadius: 7 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>{inc.title}</span>
                      <Badge value={inc.severity} map={{ critical: { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' }, high: { bg: '#fff7ed', color: 'var(--color-brand)' }, medium: { bg: '#fefce8', color: '#ca8a04' }, low: { bg: '#f0fdf4', color: '#16a34a' } }} />
                      <Badge value={inc.status} map={STEP_COLORS} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <ChangeTasks
            changeId={change.id}
            currentStep={currentStep}
            instanceId={instanceId}
            assessmentTasks={assessmentTasks}
            deploySteps={deploySteps}
            validationTask={validationTask}
            teams={teams}
            users={users}
            transitioning={transitioning}
            completingTask={completingTask}
            rejectingTask={rejectingTask}
            updatingStep={updatingStep}
            savingSteps={savingSteps}
            savingValidation={savingValidation}
            assessmentOpen={assessmentOpen}
            deployOpen={deployOpen}
            validationOpen={validationOpen}
            onSetAssessmentOpen={setAssessmentOpen}
            onSetDeployOpen={setDeployOpen}
            onSetValidationOpen={setValidationOpen}
            onExecTransition={(iId, toStep, notes) => execTransition({ variables: { instanceId: iId, toStep, notes } })}
            handlers={{
              onCompleteTask: (taskId, input) => completeTask({ variables: { taskId, input } }),
              onRejectTask: (taskId, reason) => rejectTask({ variables: { taskId, reason } }),
              onAssignTaskTeam: (taskId, teamId) => assignTaskTeam({ variables: { taskId, teamId } }),
              onAssignTaskUser: (taskId, userId) => assignTaskUser({ variables: { taskId, userId } }),
              onUpdateStepStatus: (stepId, status, notes, skipReason) => updateStepStatus({ variables: { stepId, status, notes: notes ?? null, skipReason: skipReason ?? null } }),
              onAssignStepTeam: (stepId, teamId) => assignStepTeam({ variables: { stepId, teamId } }),
              onAssignStepUser: (stepId, userId) => assignStepUser({ variables: { stepId, userId } }),
              onUpdateStepValidation: (stepId, status, notes) => updateStepValidation({ variables: { stepId, status, notes } }),
              onAssignValidationTeam: (stepId, teamId) => assignValidationTeam({ variables: { stepId, teamId } }),
              onAssignValidationUser: (stepId, userId) => assignValidationUser({ variables: { stepId, userId } }),
              onUpdateChangeTask: (id, input) => updateChangeTask({ variables: { id, input } }),
              onCompleteValidation: (changeId, notes) => completeValidation({ variables: { changeId, notes } }),
              onFailValidation: (changeId) => failValidation({ variables: { changeId } }),
              onSaveSteps: (changeId, steps) => saveSteps({ variables: { changeId, steps } }),
              onSaveValidation: (changeId, scheduledStart, scheduledEnd) => saveValidation({ variables: { changeId, scheduledStart, scheduledEnd } }),
            }}
          />

          <ChangeComments
            changeId={change.id}
            comments={change.comments}
            addingComment={addingComment}
            onAddComment={(text) => addComment({ variables: { changeId: change.id, text } })}
          />
        </div>

        {/* Right column */}
        <div style={{ width: 320, flexShrink: 0 }}>
          <ChangeDetails change={change} currentStep={currentStep} sidebarOnly />
        </div>
      </div>

      {/* ── Remove CI Dialog ──────────────────────────────────── */}
      {removeCIDialog && (
        <>
          <div onClick={() => setRemoveCIDialog(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.5)' }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 440, zIndex: 1001, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: 'var(--color-slate-dark)' }}>
              Rimuovi CI: {removeCIDialog.ciName}
            </h3>
            <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 16 }}>
              Specifica il motivo della rimozione (min. 10 caratteri).
              {change.workflowInstance?.currentStep === 'assessment' &&
                ' Il task di assessment associato verrà marcato come saltato.'}
            </p>
            <textarea
              value={removeCIReason}
              onChange={(e) => setRemoveCIReason(e.target.value)}
              placeholder="Es: CI non coinvolto in questo change..."
              rows={3}
              autoFocus
              style={{ width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 14, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setRemoveCIDialog(null)}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
              >
                Annulla
              </button>
              <button
                disabled={removeCIReason.trim().length < 10}
                onClick={() => {
                  removeCI({ variables: { changeId: change.id, ciId: removeCIDialog.ciId, reason: removeCIReason.trim() } })
                  setRemoveCIDialog(null)
                  setRemoveCIReason('')
                }}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 500,
                  cursor: removeCIReason.trim().length >= 10 ? 'pointer' : 'not-allowed',
                  backgroundColor: removeCIReason.trim().length >= 10 ? 'var(--color-trigger-sla-breach)' : '#f3f4f6',
                  color: removeCIReason.trim().length >= 10 ? '#fff' : 'var(--color-slate-light)',
                }}
              >
                Rimuovi
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Transition Dialog ─────────────────────────────────── */}
      {isTransitionOpen && pendingTransition && (
        <>
          <div onClick={() => setIsTransitionOpen(false)} style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 1000 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 420, zIndex: 1001, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 6px' }}>{pendingTransition.label}</h2>
            <p style={{ fontSize: 14, color: 'var(--color-slate-light)', margin: '0 0 16px' }}>Inserisci le informazioni richieste.</p>
            <textarea
              value={transitionNotes}
              onChange={(e) => setTransitionNotes(e.target.value)}
              style={{ ...textareaStyle, minHeight: 90, marginBottom: 16 }}
              placeholder={pendingTransition.inputField === 'rootCause' ? 'Root cause…' : 'Note…'}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => {
                  if (!instanceId) return
                  execTransition({ variables: { instanceId, toStep: pendingTransition.toStep, notes: transitionNotes || null } })
                }}
                disabled={transitioning || !transitionNotes.trim()}
                style={{ flex: 1, padding: '9px 0', backgroundColor: transitioning || !transitionNotes.trim() ? '#e2e6f0' : 'var(--color-brand)', color: transitioning || !transitionNotes.trim() ? 'var(--color-slate-light)' : '#fff', border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: transitioning || !transitionNotes.trim() ? 'not-allowed' : 'pointer' }}
              >
                {transitioning ? 'Esecuzione…' : 'Conferma'}
              </button>
              <button onClick={() => setIsTransitionOpen(false)} style={{ padding: '9px 20px', backgroundColor: '#fff', color: 'var(--color-slate)', border: '1px solid #e2e6f0', borderRadius: 7, fontSize: 14, cursor: 'pointer' }}>
                Annulla
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
