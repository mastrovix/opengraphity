import type { ImpactAnalysis } from '@/components/ImpactPanel'

export interface Team { id: string; name: string }
export interface User { id: string; name: string; email?: string; teamId?: string | null; teams?: { id: string; name: string }[] }
export interface CI {
  id: string; name: string; type: string; ciType?: string; status: string; environment: string
  owner?: { id: string; name: string } | null
  supportGroup?: { id: string; name: string } | null
}
export interface Incident { id: string; title: string; status: string; severity: string }
export interface ChangeComment {
  id: string; text: string; type: string; createdAt: string
  createdBy: { id: string; name: string } | null
}

export interface WorkflowTransition {
  toStep: string; label: string; requiresInput: boolean; inputField: string | null; condition: string | null
}
export interface WorkflowInstance { id: string; currentStep: string; status: string }
export interface WorkflowHistory {
  id: string; stepName: string; enteredAt: string; exitedAt: string | null
  durationMs: number | null; triggeredBy: string; triggerType: string; notes: string | null
}

export interface ChangeTask {
  id: string; taskType: string; changeId: string; status: string
  order: number | null; title: string | null; description: string | null
  scheduledStart: string | null; scheduledEnd: string | null; durationDays: number | null
  hasValidation: boolean | null; validationStatus: string | null
  validationStart: string | null; validationEnd: string | null; validationNotes: string | null
  skipReason: string | null; notes: string | null; completedAt: string | null
  riskLevel: string | null; impactDescription: string | null; mitigation: string | null
  type: string | null; rollbackPlan: string | null; createdAt: string | null
  ci: CI | null; assignedTeam: Team | null; assignee: User | null
  validationTeam: Team | null; validationUser: User | null
}

export interface Change {
  id: string; number: string; title: string; description: string | null; type: string; priority: string
  status: string; scheduledStart: string | null; scheduledEnd: string | null
  implementedAt: string | null; createdAt: string; updatedAt: string
  assignedTeam: Team | null; assignee: User | null; createdBy: User | null
  affectedCIs: CI[]; relatedIncidents: Incident[]
  workflowInstance: WorkflowInstance | null
  availableTransitions: WorkflowTransition[]
  workflowHistory: WorkflowHistory[]
  changeTasks: ChangeTask[]
  comments: ChangeComment[]
  impactAnalysis: ImpactAnalysis | null
}

// ── Style constants ──────────────────────────────────────────────────────────

export const TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  standard:  { bg: '#ecfdf5', color: 'var(--color-trigger-automatic)' },
  normal:    { bg: '#eff6ff', color: '#2563eb' },
  emergency: { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
}
export const PRIORITY_COLORS: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fef2f2', color: 'var(--color-trigger-sla-breach)' },
  high:     { bg: '#fff7ed', color: 'var(--color-brand)' },
  medium:   { bg: '#fefce8', color: '#ca8a04' },
  low:      { bg: '#f0fdf4', color: '#16a34a' },
}
export const STEP_COLORS: Record<string, { bg: string; color: string }> = {
  draft:              { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  approved:           { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  assessment:         { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  planning:           { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  cab_approval:       { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  scheduled:          { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  validation:         { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  deployment:         { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  completed:          { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  failed:             { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  rejected:           { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  emergency_approval: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  post_review:        { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
}
export const STATUS_STEP_COLORS: Record<string, { bg: string; color: string }> = {
  pending:     { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  in_progress: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  completed:   { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  failed:      { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  skipped:     { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
}
export const TASK_STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  open:      { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  completed: { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  skipped:   { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
  rejected:  { bg: 'var(--color-brand-light)', color: 'var(--color-brand)' },
}

export const cardStyle: React.CSSProperties = {
  backgroundColor: '#fff', border: '1px solid #e2e6f0', borderRadius: 10, padding: 20, marginBottom: 16,
}
export const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid #e2e6f0', borderRadius: 6,
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', outline: 'none', backgroundColor: '#fafafa', boxSizing: 'border-box' as const,
}
export const textareaStyle: React.CSSProperties = {
  ...inputStyle, resize: 'vertical' as const, minHeight: 72,
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
}

export function Badge({ value, map }: { value: string; map: Record<string, { bg: string; color: string }> }) {
  const c = map[value] ?? { bg: '#f3f4f6', color: 'var(--color-slate)' }
  return (
    <span style={{ ...c, padding: '2px 8px', borderRadius: 100, fontSize: 'var(--font-size-body)', fontWeight: 600, textTransform: 'uppercase' as const }}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('it-IT')
}

export function transitionBtnColor(toStep: string): { bg: string; color: string; hover: string } {
  if (['completed', 'approved', 'cab_approval'].includes(toStep)) return { bg: 'var(--color-trigger-automatic)', color: '#fff', hover: '#047857' }
  if (['failed', 'rejected'].includes(toStep)) return { bg: 'var(--color-trigger-sla-breach)', color: '#fff', hover: '#b91c1c' }
  if (toStep === 'assessment') return { bg: '#2563eb', color: '#fff', hover: '#1d4ed8' }
  if (toStep === 'planning') return { bg: 'var(--color-brand-hover)', color: '#fff', hover: '#075985' }
  if (toStep === 'deployment') return { bg: '#7c3aed', color: '#fff', hover: '#6d28d9' }
  return { bg: 'var(--color-brand)', color: '#fff', hover: 'var(--color-brand-hover)' }
}

export function groupByField<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item)
    ;(acc[k] ??= []).push(item)
    return acc
  }, {})
}
