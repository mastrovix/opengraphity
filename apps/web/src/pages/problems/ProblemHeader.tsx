import { ArrowLeft } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'
import { lookupOrError } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'
import { buttonStyleForCategory } from '@/lib/workflowStepStyle'

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
  critical: 'var(--color-trigger-sla-breach)', high: 'var(--color-brand)', medium: '#ca8a04', low: 'var(--color-success)',
}

// Every problem status renders with the same brand colours — a single value,
// no per-name lookup needed.
const STATUS_BG = 'var(--color-brand-light)'
const STATUS_FG = 'var(--color-brand)'

function transitionButtonStyle(category: string | null | undefined, disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '6px 14px', borderRadius: 6,
    fontSize: 'var(--font-size-card-title)', fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    border: '1px solid transparent', transition: 'opacity 0.15s',
  }
  return { ...base, ...buttonStyleForCategory(category) }
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
  const { byName: stepByName } = useWorkflowSteps('problem')
  return (
    <div style={{ marginBottom: 24 }}>
      <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--font-size-card-title)', padding: 0 }}>
        <ArrowLeft size={14} />
        Indietro
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>{problem.title}</h1>
        <Pill bg={PRIORITY_COLOR[problem.priority] ? `${PRIORITY_COLOR[problem.priority]}22` : 'var(--color-border-light)'} color={lookupOrError(PRIORITY_COLOR, problem.priority, 'PRIORITY_COLOR', 'var(--color-slate)')} radius={4} style={{ fontSize: 'var(--font-size-body)', border: `1px solid ${lookupOrError(PRIORITY_COLOR, problem.priority, 'PRIORITY_COLOR', '#e5e7eb')}` }}>
          {problem.priority}
        </Pill>
        <Pill bg={STATUS_BG} color={STATUS_FG} radius={4} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
          {problem.status.replace(/_/g, ' ')}
        </Pill>
      </div>
      <div style={{ fontSize: 'var(--font-size-body)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: 'var(--text-muted)' }}>{problem.id}</div>

      {manualTransitions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {manualTransitions.map((tr) => (
            <button key={tr.toStep} onClick={() => onTransitionClick(tr)} disabled={transitioning} style={transitionButtonStyle(stepByName.get(tr.toStep)?.category ?? null, transitioning)}>
              {tr.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
