import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  GET_CHANGE, GET_TEAMS, GET_USERS, GET_CIS_SEARCH,
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
} from '@/graphql/mutations'
import { ImpactPanel } from '@/components/ImpactPanel'
import type { ImpactAnalysis } from '@/components/ImpactPanel'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Team { id: string; name: string }
interface User { id: string; name: string; email?: string; teamId?: string | null }
interface CI { id: string; name: string; type: string; status: string; environment: string; owner?: { id: string; name: string } | null; supportGroup?: { id: string; name: string } | null }
interface Incident { id: string; title: string; status: string; severity: string }
interface ChangeComment { id: string; text: string; type: string; createdAt: string; createdBy: { id: string; name: string } | null }

interface WorkflowTransition {
  toStep: string; label: string; requiresInput: boolean; inputField: string | null; condition: string | null
}
interface WorkflowInstance { id: string; currentStep: string; status: string }
interface WorkflowHistory { id: string; stepName: string; enteredAt: string; exitedAt: string | null; durationMs: number | null; triggeredBy: string; triggerType: string; notes: string | null }

interface AssessmentTask {
  id: string; status: string; riskLevel: string | null; impactDescription: string | null
  mitigation: string | null; notes: string | null; completedAt: string | null
  ci: CI | null; assignedTeam: Team | null; assignee: User | null
}

interface DeployStep {
  id: string; order: number; title: string; description: string | null; status: string
  scheduledStart: string; durationDays: number; scheduledEnd: string
  hasValidation: boolean; validationStart: string | null; validationEnd: string | null
  validationStatus: string | null; validationNotes: string | null
  skipReason: string | null; notes: string | null; completedAt: string | null
  assignedTeam: Team | null; assignee: User | null; validationTeam: Team | null; validationUser: User | null
}

interface ChangeValidation {
  id: string; type: string; scheduledStart: string; scheduledEnd: string; status: string
  notes: string | null; completedAt: string | null; assignedTeam: Team | null; assignee: User | null
}

interface Change {
  id: string; title: string; description: string | null; type: string; priority: string
  status: string; rollbackPlan: string; scheduledStart: string | null; scheduledEnd: string | null
  implementedAt: string | null; createdAt: string; updatedAt: string
  assignedTeam: Team | null; assignee: User | null; createdBy: User | null
  affectedCIs: CI[]; relatedIncidents: Incident[]
  workflowInstance: WorkflowInstance | null
  availableTransitions: WorkflowTransition[]
  workflowHistory: WorkflowHistory[]
  deploySteps: DeployStep[]
  assessmentTasks: AssessmentTask[]
  validation: ChangeValidation | null
  comments: ChangeComment[]
  impactAnalysis: ImpactAnalysis | null
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  standard:  { bg: '#ecfdf5', color: '#059669' },
  normal:    { bg: '#eff6ff', color: '#2563eb' },
  emergency: { bg: '#fef2f2', color: '#dc2626' },
}
const PRIORITY_COLORS: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fef2f2', color: '#dc2626' },
  high:     { bg: '#fff7ed', color: '#ea580c' },
  medium:   { bg: '#fefce8', color: '#ca8a04' },
  low:      { bg: '#f0fdf4', color: '#16a34a' },
}
const STEP_COLORS: Record<string, { bg: string; color: string }> = {
  draft:              { bg: '#f3f4f6', color: '#6b7280' },
  approved:           { bg: '#ecfdf5', color: '#059669' },
  assessment:         { bg: '#eff6ff', color: '#2563eb' },
  planning:           { bg: '#f0f9ff', color: '#0369a1' },
  cab_approval:       { bg: '#fefce8', color: '#ca8a04' },
  scheduled:          { bg: '#f5f3ff', color: '#7c3aed' },
  validation:         { bg: '#fff7ed', color: '#ea580c' },
  deployment:         { bg: '#ecfdf5', color: '#059669' },
  completed:          { bg: '#ecfdf5', color: '#059669' },
  failed:             { bg: '#fef2f2', color: '#dc2626' },
  rejected:           { bg: '#f3f4f6', color: '#6b7280' },
  emergency_approval: { bg: '#fef2f2', color: '#dc2626' },
  post_review:        { bg: '#eff6ff', color: '#2563eb' },
}
const STATUS_STEP_COLORS: Record<string, { bg: string; color: string }> = {
  pending:     { bg: '#f3f4f6', color: '#6b7280' },
  in_progress: { bg: '#eff6ff', color: '#2563eb' },
  completed:   { bg: '#ecfdf5', color: '#059669' },
  failed:      { bg: '#fef2f2', color: '#dc2626' },
  skipped:     { bg: '#f3f4f6', color: '#8892a4' },
}
const TASK_STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  pending:     { bg: '#fefce8', color: '#ca8a04' },
  in_progress: { bg: '#eff6ff', color: '#2563eb' },
  completed:   { bg: '#ecfdf5', color: '#059669' },
  rejected:    { bg: '#fef2f2', color: '#dc2626' },
}

function Badge({ value, map }: { value: string; map: Record<string, { bg: string; color: string }> }) {
  const c = map[value] ?? { bg: '#f3f4f6', color: '#6b7280' }
  return <span style={{ ...c, padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const }}>{value.replace(/_/g, ' ')}</span>
}

const cardStyle: React.CSSProperties = {
  backgroundColor: '#fff', border: '1px solid #e2e6f0', borderRadius: 10, padding: 20, marginBottom: 16,
}
const cardTitleStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, color: '#0f1629', marginBottom: 14,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6,
  fontSize: 13, color: '#0f1629', outline: 'none', backgroundColor: '#fafafa', boxSizing: 'border-box' as const,
}
const textareaStyle: React.CSSProperties = { ...inputStyle, resize: 'vertical' as const, minHeight: 72, fontFamily: 'inherit' }

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('it-IT')
}

// ── Transition button color ───────────────────────────────────────────────────

function transitionBtnColor(toStep: string): { bg: string; color: string; hover: string } {
  if (['completed', 'approved', 'cab_approval'].includes(toStep)) return { bg: '#059669', color: '#fff', hover: '#047857' }
  if (['failed', 'rejected'].includes(toStep)) return { bg: '#dc2626', color: '#fff', hover: '#b91c1c' }
  if (toStep === 'assessment') return { bg: '#2563eb', color: '#fff', hover: '#1d4ed8' }
  if (toStep === 'planning') return { bg: '#0369a1', color: '#fff', hover: '#075985' }
  if (toStep === 'deployment') return { bg: '#7c3aed', color: '#fff', hover: '#6d28d9' }
  return { bg: '#4f46e5', color: '#fff', hover: '#4338ca' }
}

// ── Main Component ────────────────────────────────────────────────────────────

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
  const [transitionNotes, setTransitionNotes] = useState('')
  const [isTransitionOpen, setIsTransitionOpen] = useState(false)

  // CI search state
  const [ciSearch, setCiSearch]     = useState('')
  const [showCISearch, setShowCISearch] = useState(false)
  const { data: ciSearchData } = useQuery<{ configurationItems: CI[] }>(GET_CIS_SEARCH, {
    variables: { search: ciSearch || null },
    skip: ciSearch.length < 2,
  })

  // Reassign task dialog state
  const [reassignTaskId, setReassignTaskId] = useState<string | null>(null)
  const [reassignTeamId, setReassignTeamId] = useState('')
  const [showAllTeams, setShowAllTeams] = useState(false)

  // Task user assignment state
  const [assignTaskUserId, setAssignTaskUserId] = useState<Record<string, string>>({})

  // Remove CI dialog state
  const [removeCIDialog, setRemoveCIDialog] = useState<{ ciId: string; ciName: string } | null>(null)
  const [removeCIReason, setRemoveCIReason] = useState('')

  // Reject task dialog state
  const [rejectTaskDialog, setRejectTaskDialog] = useState<{ taskId: string; ciName: string } | null>(null)
  const [rejectTaskReason, setRejectTaskReason] = useState('')

  // Assessment task popup drawer
  const [assessmentTaskPopup, setAssessmentTaskPopup] = useState<string | null>(null)

  // New step form inside popup drawer
  const [newStepForm, setNewStepForm] = useState({
    title: '', scheduledStart: new Date().toISOString().split('T')[0] ?? '',
    durationDays: 1, scheduledEnd: '', hasValidation: false,
    validationStart: '', validationEnd: '', assignedTeamId: '', validationTeamId: '',
  })

  // Global validation form inside popup drawer
  const [globalValidationStart, setGlobalValidationStart] = useState('')
  const [globalValidationEnd, setGlobalValidationEnd] = useState('')

  // Deploy step popup drawer
  const [deployStepPopup, setDeployStepPopup] = useState<string | null>(null)
  const [deployPopupNotes, setDeployPopupNotes] = useState('')
  const [deployPopupShowSkip, setDeployPopupShowSkip] = useState(false)
  const [deployPopupSkipReason, setDeployPopupSkipReason] = useState('')
  const [deployPopupShowFail, setDeployPopupShowFail] = useState(false)
  const [deployPopupFailReason, setDeployPopupFailReason] = useState('')
  const [deployPopupReassignTeamId, setDeployPopupReassignTeamId] = useState('')
  const [deployPopupShowReassign, setDeployPopupShowReassign] = useState(false)
  const [deployPopupUserId, setDeployPopupUserId] = useState('')

  // Validation step popup drawer
  const [validationStepPopup, setValidationStepPopup] = useState<string | null>(null)
  const [valPopupNotes, setValPopupNotes] = useState('')
  const [valPopupReassignTeamId, setValPopupReassignTeamId] = useState('')
  const [valPopupShowReassign, setValPopupShowReassign] = useState(false)
  const [valPopupUserId, setValPopupUserId] = useState('')

  // Comment state
  const [newComment, setNewComment] = useState('')

  // Task forms state
  const [taskForms, setTaskForms] = useState<Record<string, { riskLevel: string; impactDescription: string; mitigation: string; notes: string }>>({})

  const [execTransition, { loading: transitioning }] = useMutation<{
    executeChangeTransition: { success: boolean; error: string | null; instance: { id: string; currentStep: string; status: string } }
  }>(EXECUTE_CHANGE_TRANSITION, {
    onCompleted: (data) => {
      if (data.executeChangeTransition.success) {
        toast.success('Transizione eseguita')
        setIsTransitionOpen(false)
        setTransitionNotes('')
        setPendingTransition(null)
        void refetch()
      } else {
        toast.error(data.executeChangeTransition.error ?? 'Errore transizione')
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
    onCompleted: () => { toast.success('CI aggiunto'); setCiSearch(''); setShowCISearch(false); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [removeCI] = useMutation(REMOVE_AFFECTED_CI_FROM_CHANGE, {
    onCompleted: () => { toast.success('CI rimosso'); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [addComment, { loading: addingComment }] = useMutation(ADD_CHANGE_COMMENT, {
    onCompleted: () => { toast.success('Commento aggiunto'); setNewComment(''); void refetch() },
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

  const ciResults = ciSearchData?.configurationItems ?? []
  const teams = teamsData?.teams ?? []
  const users = usersData?.users ?? []

  if (loading) return <div style={{ color: '#8892a4', fontSize: 14, padding: 40 }}>Caricamento…</div>
  if (!data?.change) return <div style={{ color: '#8892a4', fontSize: 14, padding: 40 }}>Change non trovato.</div>

  const change = data.change
  const currentStep = change.workflowInstance?.currentStep ?? change.status
  const instanceId = change.workflowInstance?.id ?? ''

  const showDeploySteps = ['assessment', 'cab_approval', 'scheduled', 'validation', 'deployment', 'completed', 'failed'].includes(currentStep)
  const deployStepsEditable = currentStep === 'assessment'
  const showAssessmentSection = currentStep === 'assessment'

  // Compute scheduledEnd for a form step
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
    <div>
      {/* Back */}
      <button
        onClick={() => navigate('/changes')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f46e5', fontSize: 13, padding: 0, marginBottom: 16 }}
      >
        ← Torna ai Changes
      </button>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f1629', margin: 0 }}>{change.title}</h1>
            <Badge value={change.type} map={TYPE_COLORS} />
            <Badge value={change.priority} map={PRIORITY_COLORS} />
            {change.workflowInstance && <Badge value={currentStep} map={STEP_COLORS} />}
          </div>
          <div style={{ fontSize: 11, color: '#8892a4', fontFamily: 'monospace' }}>{change.id}</div>
        </div>

        {/* Workflow transitions */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {change.availableTransitions.map((tr) => {
            const colors = transitionBtnColor(tr.toStep)
            return (
              <button
                key={tr.toStep}
                onClick={() => { setPendingTransition(tr); setTransitionNotes(''); setIsTransitionOpen(true) }}
                style={{ padding: '8px 16px', backgroundColor: colors.bg, color: colors.color, border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                {tr.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>

        {/* Left column */}
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* Description + Rollback */}
          <div style={cardStyle}>
            <div style={cardTitleStyle}>Descrizione</div>
            {change.description ? (
              <p style={{ fontSize: 14, color: '#0f1629', margin: 0, marginBottom: 16, lineHeight: 1.6 }}>{change.description}</p>
            ) : (
              <p style={{ fontSize: 13, color: '#8892a4', margin: 0, marginBottom: 16 }}>Nessuna descrizione.</p>
            )}
            <div style={{ borderTop: '1px solid #f1f3f8', paddingTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Piano di Rollback</div>
              <p style={{ fontSize: 13, color: '#0f1629', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{change.rollbackPlan || '—'}</p>
            </div>
          </div>

          {/* Impact Analysis */}
          {change.impactAnalysis && change.affectedCIs.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <ImpactPanel analysis={change.impactAnalysis} compact={false} />
            </div>
          )}

          {/* CI Impattati */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={cardTitleStyle}>CI Impattati</div>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 100, backgroundColor: '#f1f3f8', color: '#8892a4' }}>
                  {change.affectedCIs.length}
                </span>
              </div>
              <button
                onClick={() => setShowCISearch((v) => !v)}
                style={{ fontSize: 12, fontWeight: 600, color: '#4f46e5', background: 'none', border: '1px solid #e2e6f0', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
              >
                {showCISearch ? 'Chiudi' : '+ Aggiungi CI'}
              </button>
            </div>

            {showCISearch && (
              <div style={{ marginBottom: 12 }}>
                <input
                  type="text"
                  value={ciSearch}
                  onChange={(e) => setCiSearch(e.target.value)}
                  placeholder="Cerca CI per nome (min. 2 caratteri)…"
                  autoFocus
                  style={inputStyle}
                />
                {ciResults.filter((ci) => !change.affectedCIs.find((a) => a.id === ci.id)).length > 0 && (
                  <div style={{ border: '1px solid #e2e6f0', borderRadius: 6, marginTop: 4, backgroundColor: '#fff', maxHeight: 160, overflowY: 'auto' }}>
                    {ciResults
                      .filter((ci) => !change.affectedCIs.find((a) => a.id === ci.id))
                      .map((ci) => (
                        <div
                          key={ci.id}
                          onClick={() => addCI({ variables: { changeId: change.id, ciId: ci.id } })}
                          style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f3f8', fontSize: 13 }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#f8f9fc' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '' }}
                        >
                          <span style={{ fontWeight: 500 }}>{ci.name}</span>
                          <span style={{ color: '#8892a4', fontSize: 11, marginLeft: 8 }}>{ci.type} · {ci.environment}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {change.affectedCIs.map((ci) => (
                <span key={ci.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: '#eff6ff', color: '#2563eb', padding: '4px 10px', borderRadius: 100, fontSize: 12, fontWeight: 500 }}>
                  {ci.name} <span style={{ opacity: 0.7, fontSize: 10 }}>({ci.type})</span>
                  <button
                    type="button"
                    onClick={() => { setRemoveCIDialog({ ciId: ci.id, ciName: ci.name }); setRemoveCIReason('') }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#2563eb', padding: 0, lineHeight: 1, fontSize: 14 }}
                  >×</button>
                </span>
              ))}
              {change.affectedCIs.length === 0 && <span style={{ fontSize: 13, color: '#8892a4' }}>Nessun CI associato</span>}
            </div>
          </div>

          {/* Related Incidents */}
          {change.relatedIncidents.length > 0 && (
            <div style={cardStyle}>
              <div style={cardTitleStyle}>Incident Correlati ({change.relatedIncidents.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {change.relatedIncidents.map((inc) => (
                  <div key={inc.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', backgroundColor: '#f8f9fc', borderRadius: 7 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#0f1629', flex: 1 }}>{inc.title}</span>
                    <Badge value={inc.severity} map={{ critical: { bg: '#fef2f2', color: '#dc2626' }, high: { bg: '#fff7ed', color: '#ea580c' }, medium: { bg: '#fefce8', color: '#ca8a04' }, low: { bg: '#f0fdf4', color: '#16a34a' } }} />
                    <Badge value={inc.status} map={STEP_COLORS} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Assessment Tasks — table */}
          {showAssessmentSection && change.assessmentTasks.length > 0 && (
            <div style={cardStyle}>
              <div style={{ ...cardTitleStyle, marginBottom: 12 }}>Assessment Tasks</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                      {['CI', 'Tipo', 'Team', 'Assegnato a', 'Risk', 'Status'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {change.assessmentTasks.map((task) => (
                      <tr
                        key={task.id}
                        onClick={() => setAssessmentTaskPopup(task.id)}
                        style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                      >
                        <td style={{ padding: '10px 12px', fontWeight: 500, color: '#0f1629' }}>{task.ci?.name ?? '—'}</td>
                        <td style={{ padding: '10px 12px', color: '#8892a4', fontSize: 12 }}>{task.ci?.type ?? '—'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          {task.assignedTeam?.name ?? <span style={{ color: '#dc2626', fontSize: 12 }}>Non assegnato</span>}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          {task.assignee ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: '#4f46e5', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                {task.assignee.name.charAt(0).toUpperCase()}
                              </div>
                              <span style={{ fontSize: 12 }}>{task.assignee.name}</span>
                            </div>
                          ) : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          {task.riskLevel ? (
                            <span style={{
                              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                              backgroundColor: task.riskLevel === 'critical' ? 'rgba(239,68,68,0.1)' : task.riskLevel === 'high' ? 'rgba(249,115,22,0.1)' : task.riskLevel === 'medium' ? 'rgba(234,179,8,0.1)' : 'rgba(34,197,94,0.1)',
                              color: task.riskLevel === 'critical' ? '#dc2626' : task.riskLevel === 'high' ? '#ea580c' : task.riskLevel === 'medium' ? '#ca8a04' : '#16a34a',
                            }}>{task.riskLevel.toUpperCase()}</span>
                          ) : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>}
                        </td>
                        <td style={{ padding: '10px 12px' }}><Badge value={task.status} map={TASK_STATUS_COLORS} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Progress bar */}
              {(() => {
                const total = change.assessmentTasks.length
                const done = change.assessmentTasks.filter((t) => ['completed', 'skipped', 'rejected'].includes(t.status)).length
                return total > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#8892a4', marginBottom: 4 }}>
                      <span>Completati</span><span>{done}/{total}</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, backgroundColor: '#f1f3f8' }}>
                      <div style={{ height: '100%', borderRadius: 2, backgroundColor: done === total ? '#059669' : '#4f46e5', width: `${(done / total) * 100}%`, transition: 'width 0.3s' }} />
                    </div>
                  </div>
                ) : null
              })()}
            </div>
          )}

          {/* Deploy Steps — table */}
          {showDeploySteps && !deployStepsEditable && (
            <div style={cardStyle}>
              <div style={cardTitleStyle}>Deploy Steps ({change.deploySteps.length})</div>
              {change.deploySteps.length === 0 ? (
                <span style={{ fontSize: 13, color: '#8892a4' }}>Nessuno step pianificato.</span>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                        {['#', 'Titolo', 'Team', 'Assegnato a', 'Inizio', 'Fine', 'Status'].map((h) => (
                          <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {change.deploySteps.map((step) => (
                        <tr
                          key={step.id}
                          onClick={() => { setDeployStepPopup(step.id); setDeployPopupNotes(''); setDeployPopupShowSkip(false); setDeployPopupSkipReason(''); setDeployPopupShowFail(false); setDeployPopupFailReason(''); setDeployPopupShowReassign(false); setDeployPopupReassignTeamId(''); setDeployPopupUserId('') }}
                          style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                        >
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>#{step.order}</span>
                          </td>
                          <td style={{ padding: '10px 12px', fontWeight: 500, color: '#0f1629' }}>{step.title}</td>
                          <td style={{ padding: '10px 12px' }}>
                            {step.assignedTeam?.name ?? <span style={{ color: '#dc2626', fontSize: 12 }}>Non assegnato</span>}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            {step.assignee ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: '#4f46e5', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {step.assignee.name.charAt(0).toUpperCase()}
                                </div>
                                <span style={{ fontSize: 12 }}>{step.assignee.name}</span>
                              </div>
                            ) : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: '#8892a4' }}>{formatDate(step.scheduledStart)}</td>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: '#8892a4' }}>{formatDate(step.scheduledEnd)}</td>
                          <td style={{ padding: '10px 12px' }}><Badge value={step.status} map={STATUS_STEP_COLORS} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        {/* Validation Card */}
        {(['cab_approval', 'scheduled', 'validation', 'deployment', 'completed', 'failed'].includes(currentStep) &&
          (change.deploySteps.some((s) => s.hasValidation) || !!change.validation)) && (
          <div style={cardStyle}>
            <div style={cardTitleStyle}>Validazione</div>

            {/* Validazione globale */}
            {change.validation && (
              <div style={{ padding: 12, borderRadius: 8, border: '1px solid #e2e6f0', backgroundColor: '#fafafa', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Validazione Globale</span>
                  <Badge value={change.validation.status} map={{ ...TASK_STATUS_COLORS, passed: { bg: '#ecfdf5', color: '#059669' }, failed: { bg: '#fef2f2', color: '#dc2626' } }} />
                </div>
                <div style={{ fontSize: 12, color: '#8892a4', marginBottom: 8 }}>
                  {formatDate(change.validation.scheduledStart)} → {formatDate(change.validation.scheduledEnd)}
                </div>
                {change.validation.assignedTeam && (
                  <div style={{ fontSize: 12, marginBottom: 10 }}>
                    Team: <strong>{change.validation.assignedTeam.name}</strong>
                  </div>
                )}
                {change.validation.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button onClick={() => completeValidation({ variables: { changeId: change.id, notes: '' } })} style={{ padding: '6px 12px', borderRadius: 6, backgroundColor: '#059669', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Passa</button>
                    <button onClick={() => failValidation({ variables: { changeId: change.id } })} style={{ padding: '6px 12px', borderRadius: 6, backgroundColor: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Fallisce</button>
                  </div>
                )}
              </div>
            )}

            {/* Tabella validazioni per deploy step */}
            {change.deploySteps.filter((s) => s.hasValidation).length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e6f0' }}>
                      {['Step', 'Team', 'Assegnato a', 'Inizio', 'Fine', 'Status'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {change.deploySteps.filter((s) => s.hasValidation).map((step) => (
                      <tr
                        key={step.id}
                        onClick={() => { setValidationStepPopup(step.id); setValPopupNotes(''); setValPopupShowReassign(false); setValPopupReassignTeamId(''); setValPopupUserId('') }}
                        style={{ borderBottom: '1px solid #e2e6f0', cursor: 'pointer' }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f8f9fc' }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent' }}
                      >
                        <td style={{ padding: '10px 12px', fontWeight: 500, color: '#0f1629' }}>Step {step.order}: {step.title}</td>
                        <td style={{ padding: '10px 12px' }}>
                          {step.validationTeam?.name ?? <span style={{ color: '#dc2626', fontSize: 12 }}>Non assegnato</span>}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          {step.validationUser ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: '#4f46e5', color: '#fff', fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                {step.validationUser.name.charAt(0).toUpperCase()}
                              </div>
                              <span style={{ fontSize: 12 }}>{step.validationUser.name}</span>
                            </div>
                          ) : <span style={{ color: '#8892a4', fontSize: 12 }}>—</span>}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#8892a4' }}>{formatDate(step.validationStart ?? '')}</td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#8892a4' }}>{formatDate(step.validationEnd ?? '')}</td>
                        <td style={{ padding: '10px 12px' }}><Badge value={step.validationStatus ?? 'pending'} map={{ ...STATUS_STEP_COLORS, passed: { bg: '#ecfdf5', color: '#059669' }, failed: { bg: '#fef2f2', color: '#dc2626' } }} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!change.validation && change.deploySteps.filter((s) => s.hasValidation).length === 0 && (
              <span style={{ fontSize: 13, color: '#8892a4' }}>Nessuna validazione pianificata.</span>
            )}
          </div>
        )}

          {/* Comments */}
          <div style={cardStyle}>
            <div style={cardTitleStyle}>Commenti ({change.comments.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: change.comments.length > 0 ? 14 : 0 }}>
              {change.comments.map((cm) => {
                const typeColors: Record<string, { bg: string; color: string }> = {
                  manual:      { bg: '#f3f4f6', color: '#6b7280' },
                  ci_removed:  { bg: '#fff7ed', color: '#ea580c' },
                  task_skipped:{ bg: '#fefce8', color: '#ca8a04' },
                  step_skipped:{ bg: '#fefce8', color: '#ca8a04' },
                  rejected:    { bg: '#fef2f2', color: '#dc2626' },
                  transition:  { bg: '#eff6ff', color: '#2563eb' },
                }
                const typeLabels: Record<string, string> = {
                  manual: 'Commento', ci_removed: 'CI Rimosso',
                  task_skipped: 'Task Saltato', step_skipped: 'Step Saltato',
                  rejected: 'Rigettato', transition: 'Transizione',
                }
                const tc = typeColors[cm.type] ?? { bg: '#f3f4f6', color: '#6b7280' }
                return (
                  <div key={cm.id} style={{ padding: '10px 12px', backgroundColor: '#f8f9fc', borderRadius: 8, borderLeft: `3px solid ${tc.color}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ ...tc, padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600 }}>
                        {typeLabels[cm.type] ?? cm.type}
                      </span>
                      <span style={{ fontSize: 11, color: '#8892a4' }}>
                        {cm.createdBy?.name ?? '—'} · {new Date(cm.createdAt).toLocaleString('it-IT')}
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: '#0f1629', lineHeight: 1.5 }}>{cm.text}</p>
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Aggiungi un commento…"
                rows={2}
                style={{ flex: 1, padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'none', outline: 'none', boxSizing: 'border-box' }}
              />
              <button
                disabled={newComment.trim().length < 3 || addingComment}
                onClick={() => addComment({ variables: { changeId: change.id, text: newComment.trim() } })}
                style={{
                  padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 600,
                  cursor: newComment.trim().length >= 3 && !addingComment ? 'pointer' : 'not-allowed',
                  backgroundColor: newComment.trim().length >= 3 && !addingComment ? '#4f46e5' : '#e2e6f0',
                  color: newComment.trim().length >= 3 && !addingComment ? '#fff' : '#8892a4',
                  alignSelf: 'flex-end',
                }}
              >
                Invia
              </button>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div style={{ width: 320, flexShrink: 0 }}>

          {/* Details card */}
          <div style={cardStyle}>
            <div style={cardTitleStyle}>Dettagli</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'Tipo', value: <Badge value={change.type} map={TYPE_COLORS} /> },
                { label: 'Priorità', value: <Badge value={change.priority} map={PRIORITY_COLORS} /> },
                { label: 'Step', value: change.workflowInstance ? <Badge value={currentStep} map={STEP_COLORS} /> : '—' },
                { label: 'Team', value: change.assignedTeam?.name ?? '—' },
                { label: 'Assegnato a', value: change.assignee?.name ?? '—' },
                { label: 'Creato da', value: change.createdBy?.name ?? '—' },
                { label: 'Scheduled Start', value: change.scheduledStart ? new Date(change.scheduledStart).toLocaleDateString('it-IT') : '—' },
                { label: 'Scheduled End', value: change.scheduledEnd ? new Date(change.scheduledEnd).toLocaleDateString('it-IT') : '—' },
                { label: 'Creato il', value: new Date(change.createdAt).toLocaleString('it-IT') },
                { label: 'Aggiornato', value: new Date(change.updatedAt).toLocaleString('it-IT') },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#8892a4', fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>
                  <span style={{ fontSize: 13, color: '#0f1629', textAlign: 'right' }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Timeline */}
          {change.workflowHistory.length > 0 && (
            <div style={cardStyle}>
              <div style={cardTitleStyle}>Timeline Workflow</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {change.workflowHistory.map((exec, idx) => (
                  <div key={exec.id ?? idx} style={{ display: 'flex', gap: 12, paddingBottom: idx < change.workflowHistory.length - 1 ? 16 : 0, position: 'relative' }}>
                    {idx < change.workflowHistory.length - 1 && (
                      <div style={{ position: 'absolute', left: 7, top: 18, bottom: 0, width: 2, backgroundColor: '#e2e6f0' }} />
                    )}
                    <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: STEP_COLORS[exec.stepName]?.color ?? '#8892a4', flexShrink: 0, marginTop: 2, border: '2px solid #fff', boxShadow: '0 0 0 1px #e2e6f0' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#0f1629' }}>{exec.stepName.replace(/_/g, ' ')}</div>
                      <div style={{ fontSize: 11, color: '#8892a4' }}>{new Date(exec.enteredAt).toLocaleString('it-IT')}</div>
                      {exec.notes && <div style={{ fontSize: 11, color: '#4a5468', marginTop: 2, fontStyle: 'italic' }}>{exec.notes}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Reassign Task Dialog */}
      {reassignTaskId && (() => {
        const taskToReassign = change.assessmentTasks.find((t) => t.id === reassignTaskId)
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
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: '#0f1629' }}>Riassegna task</h3>
              {taskToReassign?.ci && (
                <p style={{ fontSize: 12, color: '#8892a4', margin: '0 0 16px' }}>CI: <strong>{taskToReassign.ci.name}</strong></p>
              )}
              {teamList.length > 0 ? (
                <select
                  value={reassignTeamId}
                  onChange={(e) => setReassignTeamId(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, marginBottom: 8, outline: 'none' }}
                >
                  <option value="">Seleziona team…</option>
                  {teamList.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              ) : (
                <p style={{ fontSize: 13, color: '#8892a4', marginBottom: 8 }}>Nessun team alternativo disponibile per questo CI.</p>
              )}
              {!showAllTeams && (
                <button
                  onClick={() => setShowAllTeams(true)}
                  style={{ fontSize: 12, color: '#4f46e5', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16 }}
                >
                  Scegli da tutti i team →
                </button>
              )}
              {showAllTeams && <div style={{ marginBottom: 16 }} />}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  onClick={() => { setReassignTaskId(null); setShowAllTeams(false) }}
                  style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
                >
                  Annulla
                </button>
                <button
                  disabled={!reassignTeamId}
                  onClick={() => {
                    assignTaskTeam({ variables: { taskId: reassignTaskId, teamId: reassignTeamId } })
                    setAssignTaskUserId((prev) => ({ ...prev, [reassignTaskId]: '' }))
                    setReassignTaskId(null)
                    setReassignTeamId('')
                    setShowAllTeams(false)
                  }}
                  style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: reassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: reassignTeamId ? '#4f46e5' : '#e2e6f0', color: reassignTeamId ? '#fff' : '#8892a4', fontSize: 13, fontWeight: 500 }}
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
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: '#0f1629' }}>
              Rigetta task: {rejectTaskDialog.ciName}
            </h3>
            <p style={{ fontSize: 13, color: '#8892a4', marginBottom: 16 }}>
              Il CI verrà rimosso dagli affected e il task sarà marcato come saltato. Motivo obbligatorio (min. 10 caratteri).
            </p>
            <textarea
              value={rejectTaskReason}
              onChange={(e) => setRejectTaskReason(e.target.value)}
              placeholder="Es: CI non rilevante per questo change..."
              rows={3}
              autoFocus
              style={{ width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setRejectTaskDialog(null)}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
              >
                Annulla
              </button>
              <button
                disabled={rejectTaskReason.trim().length < 10}
                onClick={() => {
                  rejectTask({ variables: { taskId: rejectTaskDialog.taskId, reason: rejectTaskReason.trim() } })
                  setRejectTaskDialog(null)
                  setRejectTaskReason('')
                }}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500,
                  cursor: rejectTaskReason.trim().length >= 10 ? 'pointer' : 'not-allowed',
                  backgroundColor: rejectTaskReason.trim().length >= 10 ? '#dc2626' : '#f3f4f6',
                  color: rejectTaskReason.trim().length >= 10 ? '#fff' : '#8892a4',
                }}
              >
                Conferma rigetto
              </button>
            </div>
          </div>
        </>
      )}

      {/* Remove CI Dialog */}
      {removeCIDialog && (
        <>
          <div onClick={() => setRemoveCIDialog(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.5)' }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 440, zIndex: 1001, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: '#0f1629' }}>
              Rimuovi CI: {removeCIDialog.ciName}
            </h3>
            <p style={{ fontSize: 13, color: '#8892a4', marginBottom: 16 }}>
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
              style={{ width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setRemoveCIDialog(null)}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
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
                  padding: '8px 16px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500,
                  cursor: removeCIReason.trim().length >= 10 ? 'pointer' : 'not-allowed',
                  backgroundColor: removeCIReason.trim().length >= 10 ? '#dc2626' : '#f3f4f6',
                  color: removeCIReason.trim().length >= 10 ? '#fff' : '#8892a4',
                }}
              >
                Rimuovi
              </button>
            </div>
          </div>
        </>
      )}

      {/* Transition Dialog */}
      {isTransitionOpen && pendingTransition && (
        <>
          <div onClick={() => setIsTransitionOpen(false)} style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 1000 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 420, zIndex: 1001, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0f1629', margin: '0 0 6px' }}>{pendingTransition.label}</h2>
            <p style={{ fontSize: 13, color: '#8892a4', margin: '0 0 16px' }}>
              {pendingTransition.requiresInput ? 'Inserisci le informazioni richieste.' : 'Conferma la transizione.'}
            </p>
            {pendingTransition.requiresInput && (
              <textarea
                value={transitionNotes}
                onChange={(e) => setTransitionNotes(e.target.value)}
                style={{ ...textareaStyle, minHeight: 90, marginBottom: 16 }}
                placeholder={pendingTransition.inputField === 'rootCause' ? 'Root cause…' : 'Note…'}
              />
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => {
                  if (!instanceId) return
                  execTransition({ variables: { instanceId, toStep: pendingTransition.toStep, notes: transitionNotes || null } })
                }}
                disabled={transitioning || (pendingTransition.requiresInput && !transitionNotes.trim())}
                style={{ flex: 1, padding: '9px 0', backgroundColor: transitioning ? '#e2e6f0' : '#4f46e5', color: transitioning ? '#8892a4' : '#fff', border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: transitioning ? 'not-allowed' : 'pointer' }}
              >
                {transitioning ? 'Esecuzione…' : 'Conferma'}
              </button>
              <button onClick={() => setIsTransitionOpen(false)} style={{ padding: '9px 20px', backgroundColor: '#fff', color: '#4a5468', border: '1px solid #e2e6f0', borderRadius: 7, fontSize: 14, cursor: 'pointer' }}>
                Annulla
              </button>
            </div>
          </div>
        </>
      )}

      {/* Deploy Step Popup Drawer */}
      {deployStepPopup && (() => {
        const step = change.deploySteps.find((s) => s.id === deployStepPopup)
        if (!step) return null
        const stepDone = ['completed', 'skipped', 'failed'].includes(step.status)
        const canAct = currentStep === 'deployment' && !stepDone
        const stepTeamUsers = users.filter((u) => u.teamId === step.assignedTeam?.id)

        return (
          <>
            <div onClick={() => setDeployStepPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>

              {/* Header */}
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Deploy Step</div>
                    <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0f1629', margin: '0 0 6px' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: 4, marginRight: 8 }}>#{step.order}</span>
                      {step.title}
                    </h2>
                    <Badge value={step.status} map={STATUS_STEP_COLORS} />
                  </div>
                  <button onClick={() => setDeployStepPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#8892a4', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>

              {/* Body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

                {/* Dettagli */}
                <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Dettagli</div>
                <div style={{ display: 'flex', gap: 24, marginBottom: 20, fontSize: 13 }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#8892a4', marginBottom: 2 }}>Inizio</div>
                    <div style={{ fontWeight: 500 }}>{formatDate(step.scheduledStart)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#8892a4', marginBottom: 2 }}>Fine</div>
                    <div style={{ fontWeight: 500 }}>{formatDate(step.scheduledEnd)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#8892a4', marginBottom: 2 }}>Durata</div>
                    <div style={{ fontWeight: 500 }}>{step.durationDays} {step.durationDays === 1 ? 'giorno' : 'giorni'}</div>
                  </div>
                </div>

                {/* Assegnazione */}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>

                  {/* Team */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Team</div>
                    {deployPopupShowReassign ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={deployPopupReassignTeamId}
                          onChange={(e) => setDeployPopupReassignTeamId(e.target.value)}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
                        >
                          <option value="">Seleziona team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <button
                          disabled={!deployPopupReassignTeamId}
                          onClick={() => {
                            if (deployPopupReassignTeamId) {
                              assignStepTeam({ variables: { stepId: step.id, teamId: deployPopupReassignTeamId } })
                              setDeployPopupShowReassign(false)
                              setDeployPopupReassignTeamId('')
                              setDeployPopupUserId('')
                            }
                          }}
                          style={{ padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupReassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: deployPopupReassignTeamId ? '#4f46e5' : '#e2e6f0', color: deployPopupReassignTeamId ? '#fff' : '#8892a4' }}
                        >
                          Salva
                        </button>
                        <button onClick={() => setDeployPopupShowReassign(false)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {step.assignedTeam ? (
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#0f1629' }}>{step.assignedTeam.name}</span>
                        ) : (
                          <span style={{ fontSize: 13, color: '#dc2626' }}>Non assegnato</span>
                        )}
                        <button onClick={() => setDeployPopupShowReassign(true)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: '#8892a4' }}>Riassegna</button>
                      </div>
                    )}
                  </div>

                  {/* Utente */}
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Assegnato a</div>
                    {step.assignedTeam ? (
                      step.assignee ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: '#4f46e5', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {step.assignee.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 13, color: '#0f1629' }}>{step.assignee.name}</span>
                          <button onClick={() => setDeployPopupUserId('')} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: '#8892a4' }}>Cambia</button>
                        </div>
                      ) : (
                        <select
                          value={deployPopupUserId}
                          onChange={(e) => {
                            const userId = e.target.value
                            setDeployPopupUserId(userId)
                            if (userId) assignStepUser({ variables: { stepId: step.id, userId } })
                          }}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
                        >
                          <option value="">Assegna utente...</option>
                          {stepTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      )
                    ) : (
                      <span style={{ fontSize: 13, color: '#8892a4' }}>— (assegna prima un team)</span>
                    )}
                  </div>
                </div>

                {/* Azioni — solo deployment step e status attivo */}
                {canAct && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Azioni</div>

                    {!step.assignedTeam && (
                      <div style={{ fontSize: 12, color: '#dc2626', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(220,38,38,0.06)', marginBottom: 12 }}>⚠ Assegna un team allo step per procedere</div>
                    )}

                    {(step.status === 'pending' || step.status === 'in_progress') && (
                      <>
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 11, color: '#8892a4', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per completare)</label>
                          <textarea
                            value={deployPopupNotes}
                            onChange={(e) => setDeployPopupNotes(e.target.value)}
                            rows={3}
                            placeholder="Descrivi il risultato del deployment..."
                            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }}
                          />
                        </div>

                        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                          <button
                            disabled={!deployPopupNotes.trim() || !step.assignedTeam || updatingStep}
                            onClick={() => { updateStepStatus({ variables: { stepId: step.id, status: 'completed', notes: deployPopupNotes.trim() } }); setDeployStepPopup(null) }}
                            style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 600, cursor: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? '#059669' : '#e2e6f0', color: deployPopupNotes.trim() && step.assignedTeam && !updatingStep ? '#fff' : '#8892a4' }}
                          >
                            ✓ Completa
                          </button>
                          <button
                            onClick={() => { setDeployPopupShowFail(true); setDeployPopupShowSkip(false) }}
                            style={{ padding: '9px 14px', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', backgroundColor: '#fef2f2', color: '#dc2626' }}
                          >
                            Fallito
                          </button>
                          <button
                            onClick={() => { setDeployPopupShowSkip(true); setDeployPopupShowFail(false) }}
                            style={{ padding: '9px 14px', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', backgroundColor: '#f3f4f6', color: '#6b7280' }}
                          >
                            Salta
                          </button>
                        </div>

                        {/* Skip inline form */}
                        {deployPopupShowSkip && (
                          <div style={{ padding: 14, borderRadius: 8, border: '1px solid #e2e6f0', backgroundColor: '#fafafa', marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>Motivo del salto (min. 10 caratteri)</div>
                            <textarea
                              value={deployPopupSkipReason}
                              onChange={(e) => setDeployPopupSkipReason(e.target.value)}
                              rows={3}
                              autoFocus
                              placeholder="Es: Step non necessario per questo ambiente..."
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'none', outline: 'none', marginBottom: 8 }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                disabled={deployPopupSkipReason.trim().length < 10 || updatingStep}
                                onClick={() => { updateStepStatus({ variables: { stepId: step.id, status: 'skipped', skipReason: deployPopupSkipReason.trim() } }); setDeployStepPopup(null) }}
                                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? '#4f46e5' : '#e2e6f0', color: deployPopupSkipReason.trim().length >= 10 && !updatingStep ? '#fff' : '#8892a4' }}
                              >
                                Conferma salto
                              </button>
                              <button onClick={() => setDeployPopupShowSkip(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>Annulla</button>
                            </div>
                          </div>
                        )}

                        {/* Fail inline form */}
                        {deployPopupShowFail && (
                          <div style={{ padding: 14, borderRadius: 8, border: '1px solid #fecaca', backgroundColor: 'rgba(254,242,242,0.5)', marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#dc2626', marginBottom: 8 }}>Motivo del fallimento (min. 10 caratteri)</div>
                            <textarea
                              value={deployPopupFailReason}
                              onChange={(e) => setDeployPopupFailReason(e.target.value)}
                              rows={3}
                              autoFocus
                              placeholder="Es: Errore di deploy, rollback eseguito..."
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #fecaca', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'none', outline: 'none', marginBottom: 8 }}
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                disabled={deployPopupFailReason.trim().length < 10 || updatingStep}
                                onClick={() => { updateStepStatus({ variables: { stepId: step.id, status: 'failed', notes: deployPopupFailReason.trim() } }); setDeployStepPopup(null) }}
                                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: deployPopupFailReason.trim().length >= 10 && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: deployPopupFailReason.trim().length >= 10 && !updatingStep ? '#dc2626' : '#e2e6f0', color: deployPopupFailReason.trim().length >= 10 && !updatingStep ? '#fff' : '#8892a4' }}
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

                {/* Read-only per step completati/saltati/falliti */}
                {stepDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {step.skipReason && (
                      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8, fontStyle: 'italic' }}>Motivo salto: {step.skipReason}</div>
                    )}
                    {step.notes && (
                      <div style={{ fontSize: 13, color: '#0f1629', marginBottom: 8, lineHeight: 1.5 }}>{step.notes}</div>
                    )}
                    {step.completedAt && (
                      <div style={{ fontSize: 12, color: '#8892a4' }}>Completato il: {new Date(step.completedAt).toLocaleString('it-IT')}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* Validation Step Popup Drawer */}
      {validationStepPopup && (() => {
        const step = change.deploySteps.find((s) => s.id === validationStepPopup)
        if (!step) return null
        const valDone = step.validationStatus === 'passed' || step.validationStatus === 'failed'
        const canAct = currentStep === 'validation' && !valDone
        const valTeamUsers = users.filter((u) => u.teamId === step.validationTeam?.id)

        return (
          <>
            <div onClick={() => setValidationStepPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 520, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>

              {/* Header */}
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Validazione Step</div>
                    <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0f1629', margin: '0 0 6px' }}>Step {step.order}: {step.title}</h2>
                    <Badge value={step.validationStatus ?? 'pending'} map={{ ...STATUS_STEP_COLORS, passed: { bg: '#ecfdf5', color: '#059669' }, failed: { bg: '#fef2f2', color: '#dc2626' } }} />
                  </div>
                  <button onClick={() => setValidationStepPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#8892a4', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>

              {/* Body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

                {/* Finestra di validazione */}
                {step.validationStart && step.validationEnd && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Finestra di Validazione</div>
                    <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
                      <div>
                        <div style={{ fontSize: 11, color: '#8892a4', marginBottom: 2 }}>Inizio</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(step.validationStart)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: '#8892a4', marginBottom: 2 }}>Fine</div>
                        <div style={{ fontWeight: 500 }}>{formatDate(step.validationEnd)}</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Assegnazione validazione */}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Assegnazione</div>

                  {/* Team validazione */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Team Validazione</div>
                    {valPopupShowReassign ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={valPopupReassignTeamId}
                          onChange={(e) => setValPopupReassignTeamId(e.target.value)}
                          style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
                        >
                          <option value="">Seleziona team…</option>
                          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <button
                          disabled={!valPopupReassignTeamId}
                          onClick={() => {
                            if (valPopupReassignTeamId) {
                              assignValidationTeam({ variables: { stepId: step.id, teamId: valPopupReassignTeamId } })
                              setValPopupShowReassign(false)
                              setValPopupReassignTeamId('')
                              setValPopupUserId('')
                            }
                          }}
                          style={{ padding: '8px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: valPopupReassignTeamId ? 'pointer' : 'not-allowed', backgroundColor: valPopupReassignTeamId ? '#4f46e5' : '#e2e6f0', color: valPopupReassignTeamId ? '#fff' : '#8892a4' }}
                        >
                          Salva
                        </button>
                        <button onClick={() => setValPopupShowReassign(false)} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {step.validationTeam ? (
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#0f1629' }}>{step.validationTeam.name}</span>
                        ) : (
                          <span style={{ fontSize: 13, color: '#dc2626' }}>Non assegnato</span>
                        )}
                        {!valDone && <button onClick={() => setValPopupShowReassign(true)} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: '#8892a4' }}>Riassegna</button>}
                      </div>
                    )}
                  </div>

                  {/* Utente validazione */}
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Responsabile Validazione</div>
                    {step.validationTeam ? (
                      step.validationUser ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: '#ea580c', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {step.validationUser.name.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontSize: 13, color: '#0f1629' }}>{step.validationUser.name}</span>
                          {!valDone && <button onClick={() => setValPopupUserId('')} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: '#8892a4' }}>Cambia</button>}
                        </div>
                      ) : (
                        <select
                          value={valPopupUserId}
                          onChange={(e) => {
                            const userId = e.target.value
                            setValPopupUserId(userId)
                            if (userId) assignValidationUser({ variables: { stepId: step.id, userId } })
                          }}
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
                        >
                          <option value="">Assegna responsabile...</option>
                          {valTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      )
                    ) : (
                      <span style={{ fontSize: 13, color: '#8892a4' }}>— (assegna prima un team)</span>
                    )}
                  </div>
                </div>

                {/* Azioni */}
                {canAct && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Azioni</div>

                    {!step.validationTeam && (
                      <div style={{ fontSize: 12, color: '#dc2626', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(220,38,38,0.06)', marginBottom: 12 }}>⚠ Assegna un team di validazione per procedere</div>
                    )}

                    <div style={{ marginBottom: 10 }}>
                      <label style={{ fontSize: 11, color: '#8892a4', fontWeight: 700, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Note (obbligatorie per fallimento)</label>
                      <textarea
                        value={valPopupNotes}
                        onChange={(e) => setValPopupNotes(e.target.value)}
                        rows={3}
                        placeholder="Note della validazione..."
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }}
                      />
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        disabled={!step.validationTeam || updatingStep}
                        onClick={() => { updateStepValidation({ variables: { stepId: step.id, status: 'passed', notes: valPopupNotes || null } }); setValidationStepPopup(null) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 600, cursor: step.validationTeam && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: step.validationTeam && !updatingStep ? '#059669' : '#e2e6f0', color: step.validationTeam && !updatingStep ? '#fff' : '#8892a4' }}
                      >
                        ✓ Passa
                      </button>
                      <button
                        disabled={!step.validationTeam || !valPopupNotes.trim() || updatingStep}
                        onClick={() => { updateStepValidation({ variables: { stepId: step.id, status: 'failed', notes: valPopupNotes.trim() } }); setValidationStepPopup(null) }}
                        style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 600, cursor: step.validationTeam && valPopupNotes.trim() && !updatingStep ? 'pointer' : 'not-allowed', backgroundColor: step.validationTeam && valPopupNotes.trim() && !updatingStep ? '#dc2626' : '#e2e6f0', color: step.validationTeam && valPopupNotes.trim() && !updatingStep ? '#fff' : '#8892a4' }}
                      >
                        ✗ Fallisce
                      </button>
                    </div>
                  </div>
                )}

                {/* Read-only per validazione completata */}
                {valDone && (
                  <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Risultato</div>
                    {step.validationNotes && (
                      <div style={{ fontSize: 13, color: '#0f1629', marginBottom: 8, lineHeight: 1.5 }}>{step.validationNotes}</div>
                    )}
                    {step.completedAt && (
                      <div style={{ fontSize: 12, color: '#8892a4' }}>Completato il: {new Date(step.completedAt).toLocaleString('it-IT')}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

      {/* Assessment Task Popup Drawer */}
      {assessmentTaskPopup && (() => {
        const task = change.assessmentTasks.find((t) => t.id === assessmentTaskPopup)
        if (!task) return null
        const taskForm = getTaskForm(task.id)
        const isEditable = ['pending', 'in_progress'].includes(task.status)
        const isDone = ['completed', 'rejected'].includes(task.status)
        const taskTeamUsers = users.filter((u) => u.teamId === task.assignedTeam?.id)

        return (
          <>
            <div onClick={() => setAssessmentTaskPopup(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 560, backgroundColor: '#fff', zIndex: 1001, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>

              {/* Header */}
              <div style={{ padding: '20px 24px', borderBottom: '1px solid #e2e6f0', flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Assessment Task</div>
                    <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0f1629', margin: '0 0 6px' }}>{task.ci?.name ?? '—'}</h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {task.ci?.type && <span style={{ fontSize: 11, color: '#8892a4', backgroundColor: '#f3f4f6', padding: '2px 8px', borderRadius: 4 }}>{task.ci.type}</span>}
                      {task.ci?.environment && <span style={{ fontSize: 11, color: '#8892a4' }}>{task.ci.environment}</span>}
                      <Badge value={task.status} map={TASK_STATUS_COLORS} />
                    </div>
                  </div>
                  <button onClick={() => setAssessmentTaskPopup(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#8892a4', lineHeight: 1, padding: 4 }}>×</button>
                </div>
              </div>

              {/* Scrollable body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

                {/* ── Section 1: Assessment ─────────────────────────── */}
                <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Assessment</div>

                {/* Team */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Team</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {task.assignedTeam ? (
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#0f1629' }}>{task.assignedTeam.name}</span>
                    ) : (
                      <span style={{ fontSize: 13, color: '#dc2626' }}>Non assegnato</span>
                    )}
                    {isEditable && (
                      <button
                        onClick={() => { setReassignTaskId(task.id); setReassignTeamId(''); setAssessmentTaskPopup(null) }}
                        style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: '#8892a4' }}
                      >
                        Riassegna
                      </button>
                    )}
                  </div>
                </div>

                {/* User — editable */}
                {isEditable && task.assignedTeam && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Assegnato a</div>
                    {task.assignee ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: '#4f46e5', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {task.assignee.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: 13, color: '#0f1629' }}>{task.assignee.name}</span>
                        <button
                          onClick={() => setAssignTaskUserId((prev) => ({ ...prev, [task.id]: '' }))}
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: '#8892a4' }}
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
                          if (userId) assignTaskUser({ variables: { taskId: task.id, userId } })
                        }}
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
                      >
                        <option value="">Assegna utente...</option>
                        {taskTeamUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    )}
                  </div>
                )}

                {/* User — read-only for done tasks */}
                {isDone && task.assignee && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Assegnato a</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: '#4f46e5', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {task.assignee.name.charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontSize: 13, color: '#0f1629' }}>{task.assignee.name}</span>
                    </div>
                  </div>
                )}

                {/* Risk Level */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Risk Level</div>
                  {isEditable ? (
                    <select value={taskForm.riskLevel} onChange={(e) => setTaskForm(task.id, { riskLevel: e.target.value })} style={inputStyle}>
                      {['low', 'medium', 'high', 'critical'].map((r) => (
                        <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ fontSize: 13, color: '#0f1629' }}>{task.riskLevel ?? '—'}</span>
                  )}
                </div>

                {/* Impact */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Descrizione impatto</div>
                  {isEditable ? (
                    <textarea value={taskForm.impactDescription} onChange={(e) => setTaskForm(task.id, { impactDescription: e.target.value })} rows={3} style={textareaStyle} placeholder="Descrivi l'impatto del change su questo CI..." />
                  ) : (
                    <p style={{ fontSize: 13, color: '#0f1629', margin: 0, lineHeight: 1.5 }}>{task.impactDescription ?? '—'}</p>
                  )}
                </div>

                {/* Mitigation */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Mitigazione</div>
                  {isEditable ? (
                    <textarea value={taskForm.mitigation} onChange={(e) => setTaskForm(task.id, { mitigation: e.target.value })} rows={2} style={textareaStyle} placeholder="Piano di mitigazione..." />
                  ) : (
                    <p style={{ fontSize: 13, color: '#0f1629', margin: 0, lineHeight: 1.5 }}>{task.mitigation ?? '—'}</p>
                  )}
                </div>

                {/* Notes */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', marginBottom: 6 }}>Note</div>
                  {isEditable ? (
                    <textarea value={taskForm.notes} onChange={(e) => setTaskForm(task.id, { notes: e.target.value })} rows={2} style={textareaStyle} placeholder="Note aggiuntive..." />
                  ) : (
                    <p style={{ fontSize: 13, color: '#0f1629', margin: 0, lineHeight: 1.5 }}>{task.notes ?? '—'}</p>
                  )}
                </div>

                {/* Action buttons */}
                {isEditable && (
                  <div style={{ marginBottom: 24 }}>
                    {!task.assignedTeam && (
                      <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>⚠ Assegna un team prima di completare</div>
                    )}
                    {task.assignedTeam && (
                      <>
                        {change.deploySteps.length === 0 && (
                          <div style={{ fontSize: 12, color: '#ca8a04', padding: '8px 12px', borderRadius: 6, backgroundColor: 'rgba(234,179,8,0.08)', marginBottom: 8 }}>
                            ⚠ Aggiungi almeno uno step di deployment prima di completare il task
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => {
                              completeTask({ variables: { taskId: task.id, input: { riskLevel: taskForm.riskLevel, impactDescription: taskForm.impactDescription, mitigation: taskForm.mitigation || null, notes: taskForm.notes || null } } })
                              setAssessmentTaskPopup(null)
                            }}
                            disabled={completingTask || !taskForm.impactDescription.trim() || !taskForm.riskLevel || change.deploySteps.length === 0}
                            style={{ flex: 1, padding: '9px 0', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 600, cursor: taskForm.impactDescription.trim() && taskForm.riskLevel && change.deploySteps.length > 0 && !completingTask ? 'pointer' : 'not-allowed', backgroundColor: taskForm.impactDescription.trim() && taskForm.riskLevel && change.deploySteps.length > 0 && !completingTask ? '#059669' : '#e2e6f0', color: taskForm.impactDescription.trim() && taskForm.riskLevel && change.deploySteps.length > 0 && !completingTask ? '#fff' : '#8892a4' }}
                          >
                            {completingTask ? 'Completamento…' : '✓ Completa task'}
                          </button>
                          <button
                            onClick={() => { setRejectTaskDialog({ taskId: task.id, ciName: task.ci?.name ?? '—' }); setAssessmentTaskPopup(null) }}
                            disabled={rejectingTask}
                            style={{ padding: '9px 16px', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', backgroundColor: '#fef2f2', color: '#dc2626' }}
                          >
                            Rigetta
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ── Section 2: Piano di Deployment ── */}
                <div style={{ borderTop: '1px solid #e2e6f0', paddingTop: 20, marginTop: 4 }}>
                    {/* Separator label */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                      <div style={{ flex: 1, height: 1, backgroundColor: '#e2e6f0' }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>Piano di Deployment</span>
                      <div style={{ flex: 1, height: 1, backgroundColor: '#e2e6f0' }} />
                    </div>

                    {/* Existing steps list */}
                    {change.deploySteps.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                        {change.deploySteps.map((step) => (
                          <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', backgroundColor: '#f8f9fc', borderRadius: 7 }}>
                            <span style={{ backgroundColor: '#4f46e5', color: '#fff', width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{step.order}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: '#0f1629' }}>{step.title}</div>
                              <div style={{ fontSize: 11, color: '#8892a4' }}>
                                {formatDate(step.scheduledStart)} → {formatDate(step.scheduledEnd)}
                                {step.assignedTeam && <span style={{ marginLeft: 8 }}>· {step.assignedTeam.name}</span>}
                              </div>
                            </div>
                            <Badge value={step.status} map={STATUS_STEP_COLORS} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p style={{ fontSize: 13, color: '#8892a4', marginBottom: 14 }}>Nessuno step pianificato.</p>
                    )}

                    {/* Add step form — only when currentStep === 'assessment' */}
                    {deployStepsEditable && (
                      <div style={{ marginTop: 8, padding: 16, borderRadius: 8, border: '1px dashed #e2e6f0', backgroundColor: '#fafafa' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Aggiungi step</div>

                        <input
                          placeholder="Titolo step *"
                          value={newStepForm.title}
                          onChange={(e) => setNewStepForm((p) => ({ ...p, title: e.target.value }))}
                          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, marginBottom: 8, fontFamily: 'inherit', outline: 'none' }}
                        />

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                          <div>
                            <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>DATA INIZIO *</label>
                            <input
                              type="date"
                              value={newStepForm.scheduledStart}
                              onChange={(e) => {
                                const start = e.target.value
                                setNewStepForm((p) => ({ ...p, scheduledStart: start, scheduledEnd: calcEnd(start, p.durationDays) }))
                              }}
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>DURATA (GG) *</label>
                            <input
                              type="number"
                              min={1}
                              value={newStepForm.durationDays}
                              onChange={(e) => {
                                const days = parseInt(e.target.value) || 1
                                setNewStepForm((p) => ({ ...p, durationDays: days, scheduledEnd: calcEnd(p.scheduledStart, days) }))
                              }}
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>FINE PREVISTA</label>
                            <input
                              readOnly
                              value={newStepForm.scheduledEnd}
                              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, backgroundColor: '#f3f4f6', color: '#8892a4' }}
                            />
                          </div>
                        </div>

                        <div style={{ marginBottom: 8 }}>
                          <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>TEAM DEPLOY</label>
                          <select
                            value={newStepForm.assignedTeamId}
                            onChange={(e) => setNewStepForm((p) => ({ ...p, assignedTeamId: e.target.value }))}
                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
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
                          <label htmlFor="popupHasValidation" style={{ fontSize: 13, cursor: 'pointer' }}>Ha finestra di validazione propria</label>
                        </div>

                        {newStepForm.hasValidation && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8, marginTop: 8 }}>
                            <div>
                              <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>INIZIO VALIDAZIONE *</label>
                              <input type="date" value={newStepForm.validationStart} onChange={(e) => setNewStepForm((p) => ({ ...p, validationStart: e.target.value }))} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }} />
                            </div>
                            <div>
                              <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>FINE VALIDAZIONE *</label>
                              <input type="date" value={newStepForm.validationEnd} onChange={(e) => setNewStepForm((p) => ({ ...p, validationEnd: e.target.value }))} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }} />
                            </div>
                            <div style={{ gridColumn: '1/-1' }}>
                              <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>TEAM VALIDAZIONE</label>
                              <select
                                value={newStepForm.validationTeamId}
                                onChange={(e) => setNewStepForm((p) => ({ ...p, validationTeamId: e.target.value }))}
                                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }}
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
                            const existingSteps = change.deploySteps.map((s) => ({
                              order: s.order, title: s.title, description: s.description ?? null,
                              scheduledStart: s.scheduledStart, durationDays: s.durationDays,
                              hasValidation: s.hasValidation,
                              validationStart: s.validationStart ?? null, validationEnd: s.validationEnd ?? null,
                              assignedTeamId: s.assignedTeam?.id ?? null,
                            }))
                            saveSteps({
                              variables: {
                                changeId: change.id,
                                steps: [...existingSteps, {
                                  order: change.deploySteps.length + 1,
                                  title: newStepForm.title.trim(),
                                  description: null,
                                  scheduledStart: newStepForm.scheduledStart,
                                  durationDays: newStepForm.durationDays,
                                  hasValidation: newStepForm.hasValidation,
                                  validationStart: newStepForm.hasValidation ? newStepForm.validationStart || null : null,
                                  validationEnd: newStepForm.hasValidation ? newStepForm.validationEnd || null : null,
                                  assignedTeamId: newStepForm.assignedTeamId || null,
                                }],
                              },
                            })
                            setNewStepForm({
                              title: '', scheduledStart: new Date().toISOString().split('T')[0] ?? '',
                              durationDays: 1, scheduledEnd: '', hasValidation: false,
                              validationStart: '', validationEnd: '', assignedTeamId: '', validationTeamId: '',
                            })
                          }}
                          style={{ marginTop: 12, width: '100%', padding: '8px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: newStepForm.title.trim() && newStepForm.scheduledStart && !savingSteps ? 'pointer' : 'not-allowed', backgroundColor: newStepForm.title.trim() && newStepForm.scheduledStart && !savingSteps ? '#4f46e5' : '#e2e6f0', color: newStepForm.title.trim() && newStepForm.scheduledStart && !savingSteps ? '#fff' : '#8892a4' }}
                        >
                          {savingSteps ? 'Salvataggio…' : '+ Aggiungi step'}
                        </button>
                      </div>
                    )}

                    {/* Global validation form — when no step has own validation and there are steps */}
                    {deployStepsEditable && change.deploySteps.length > 0 && !change.deploySteps.some((s) => s.hasValidation) && (
                      <div style={{ marginTop: 16, padding: 16, borderRadius: 8, border: '1px solid #fde68a', backgroundColor: 'rgba(234,179,8,0.05)' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#ca8a04', marginBottom: 12 }}>
                          ⚠ Nessuno step ha validazione propria — definisci la finestra di validazione globale
                        </div>
                        {change.validation ? (
                          <div style={{ fontSize: 13, color: '#4a5468' }}>
                            Pianificata: {formatDate(change.validation.scheduledStart)} → {formatDate(change.validation.scheduledEnd)}
                            {' '}<Badge value={change.validation.status} map={TASK_STATUS_COLORS} />
                          </div>
                        ) : (
                          <>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                              <div>
                                <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>INIZIO VALIDAZIONE *</label>
                                <input type="date" value={globalValidationStart} onChange={(e) => setGlobalValidationStart(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }} />
                              </div>
                              <div>
                                <label style={{ fontSize: 11, color: '#8892a4', display: 'block', marginBottom: 4 }}>FINE VALIDAZIONE *</label>
                                <input type="date" value={globalValidationEnd} onChange={(e) => setGlobalValidationEnd(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 8, border: '1px solid #e2e6f0', fontSize: 13, outline: 'none' }} />
                              </div>
                            </div>
                            <button
                              disabled={!globalValidationStart || !globalValidationEnd || savingValidation}
                              onClick={() => saveValidation({ variables: { changeId: change.id, scheduledStart: globalValidationStart, scheduledEnd: globalValidationEnd } })}
                              style={{ width: '100%', padding: '8px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: globalValidationStart && globalValidationEnd && !savingValidation ? 'pointer' : 'not-allowed', backgroundColor: globalValidationStart && globalValidationEnd && !savingValidation ? '#4f46e5' : '#e2e6f0', color: globalValidationStart && globalValidationEnd && !savingValidation ? '#fff' : '#8892a4' }}
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
