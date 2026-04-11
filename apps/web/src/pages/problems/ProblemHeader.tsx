import { ArrowLeft } from 'lucide-react'

interface WorkflowTransition {
  toStep:        string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
}

interface Problem {
  id:       string
  title:    string
  priority: string
  status:   string
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: 'var(--color-trigger-sla-breach)', high: 'var(--color-brand)', medium: '#ca8a04', low: '#16a34a',
}

const STATUS_BG: Record<string, string> = {
  new: 'var(--color-brand-light)', under_investigation: 'var(--color-brand-light)', change_requested: 'var(--color-brand-light)',
  change_in_progress: 'var(--color-brand-light)', resolved: 'var(--color-brand-light)', closed: 'var(--color-brand-light)',
  rejected: 'var(--color-brand-light)', deferred: 'var(--color-brand-light)',
}

const STATUS_FG: Record<string, string> = {
  new: 'var(--color-brand)', under_investigation: 'var(--color-brand)', change_requested: 'var(--color-brand)',
  change_in_progress: 'var(--color-brand)', resolved: 'var(--color-brand)', closed: 'var(--color-brand)',
  rejected: 'var(--color-brand)', deferred: 'var(--color-brand)',
}

function transitionButtonStyle(toStep: string, disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, border: '1px solid transparent', transition: 'opacity 0.15s' }
  if (toStep === 'resolved') return { ...base, backgroundColor: 'var(--color-trigger-automatic)', color: '#fff', borderColor: 'var(--color-trigger-automatic)' }
  if (toStep === 'rejected') return { ...base, backgroundColor: 'var(--color-trigger-sla-breach)', color: '#fff', borderColor: 'var(--color-trigger-sla-breach)' }
  if (toStep === 'closed')   return { ...base, backgroundColor: 'transparent', color: 'var(--text-primary)', borderColor: 'var(--border)' }
  return { ...base, backgroundColor: 'transparent', color: 'var(--text-primary)', borderColor: 'var(--border)' }
}

interface ProblemHeaderProps {
  problem:            Problem
  manualTransitions:  WorkflowTransition[]
  transitioning:      boolean
  onBack:             () => void
  onTransitionClick:  (tr: WorkflowTransition) => void
}

export function ProblemHeader({
  problem,
  manualTransitions,
  transitioning,
  onBack,
  onTransitionClick,
}: ProblemHeaderProps) {
  return (
    <div style={{ marginBottom: 24 }}>
      <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--font-size-card-title)', padding: 0 }}>
        <ArrowLeft size={14} />
        Indietro
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>{problem.title}</h1>
        <span style={{ padding: '2px 8px', borderRadius: 4, backgroundColor: PRIORITY_COLOR[problem.priority] ? `${PRIORITY_COLOR[problem.priority]}22` : '#f3f4f6', color: PRIORITY_COLOR[problem.priority] ?? 'var(--color-slate)', fontSize: 'var(--font-size-body)', fontWeight: 600, border: `1px solid ${PRIORITY_COLOR[problem.priority] ?? '#e5e7eb'}` }}>
          {problem.priority}
        </span>
        <span style={{ padding: '2px 8px', borderRadius: 4, backgroundColor: STATUS_BG[problem.status] ?? '#f3f4f6', color: STATUS_FG[problem.status] ?? 'var(--color-slate)', fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
          {problem.status.replace(/_/g, ' ')}
        </span>
      </div>
      <div style={{ fontSize: 'var(--font-size-body)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--text-muted)' }}>{problem.id}</div>

      {manualTransitions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {manualTransitions.map((tr) => (
            <button key={tr.toStep} onClick={() => onTransitionClick(tr)} disabled={transitioning} style={transitionButtonStyle(tr.toStep, transitioning)}>
              {tr.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
