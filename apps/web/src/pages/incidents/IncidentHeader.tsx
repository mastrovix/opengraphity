import { ArrowLeft } from 'lucide-react'
import { SeverityBadge } from '@/components/SeverityBadge'
import { StatusBadge }   from '@/components/StatusBadge'

interface WorkflowTransition {
  toStep:        string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
}

interface WorkflowInstance {
  id:          string
  currentStep: string
  status:      string
}

interface Incident {
  id:                   string
  number:               string
  title:                string
  severity:             string
  status:               string
  workflowInstance:     WorkflowInstance | null
  availableTransitions: WorkflowTransition[]
}

function transitionButtonStyle(toStep: string, disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding:      '6px 14px',
    borderRadius: 6,
    fontSize:     13,
    fontWeight:   500,
    cursor:       disabled ? 'not-allowed' : 'pointer',
    opacity:      disabled ? 0.5 : 1,
    border:       '1px solid transparent',
    transition:   'opacity 0.15s',
  }
  if (toStep === 'resolved')  return { ...base, backgroundColor: 'var(--color-trigger-automatic)', color: '#fff', borderColor: 'var(--color-trigger-automatic)' }
  if (toStep === 'escalated') return { ...base, backgroundColor: 'var(--color-trigger-sla-breach)', color: '#fff', borderColor: 'var(--color-trigger-sla-breach)' }
  if (toStep === 'closed')    return { ...base, backgroundColor: 'transparent', color: 'var(--text-primary)', borderColor: 'var(--border)' }
  console.error(`[transitionButtonStyle] valore sconosciuto: "${toStep}"`)
  return { ...base, backgroundColor: 'transparent', color: 'var(--text-primary)', borderColor: 'var(--border)' }
}

interface IncidentHeaderProps {
  incident:              Incident
  manualTransitions:     WorkflowTransition[]
  transitioning:         boolean
  onBack:                () => void
  onTransitionClick:     (tr: WorkflowTransition) => void
}

export function IncidentHeader({
  incident,
  manualTransitions,
  transitioning,
  onBack,
  onTransitionClick,
}: IncidentHeaderProps) {
  return (
    <div style={{ marginBottom: 24 }}>
      {/* Row 1 — back */}
      <button
        onClick={onBack}
        style={{
          display:      'inline-flex',
          alignItems:   'center',
          gap:          6,
          marginBottom: 12,
          background:   'none',
          border:       'none',
          cursor:       'pointer',
          color:        'var(--text-muted)',
          fontSize:     13,
          padding:      0,
        }}
      >
        <ArrowLeft size={14} />
        Indietro
      </button>

      {/* Row 2 — number + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>
          {incident.number}
        </h1>
        <SeverityBadge value={incident.severity} />
        <StatusBadge   value={incident.status} />
      </div>

      {/* Row 3 — title */}
      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>
        {incident.title}
      </div>

      {/* Workflow action buttons */}
      {manualTransitions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          {manualTransitions.map((tr) => (
            <button
              key={tr.toStep}
              onClick={() => onTransitionClick(tr)}
              disabled={transitioning}
              style={transitionButtonStyle(tr.toStep, transitioning)}
            >
              {tr.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
