import type { Change, WorkflowTransition } from './change-types'
import { Badge, TYPE_COLORS, PRIORITY_COLORS, STEP_COLORS, transitionBtnColor } from './change-types'

interface Props {
  change: Change
  currentStep: string
  instanceId: string
  transitioning: boolean
  onTransition: (tr: WorkflowTransition) => void
}

export function ChangeHeader({ change, currentStep, instanceId: _instanceId, transitioning, onTransition }: Props) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{change.number}</h1>
          <Badge value={change.type} map={TYPE_COLORS} />
          <Badge value={change.priority} map={PRIORITY_COLORS} />
          {change.workflowInstance && <Badge value={currentStep} map={STEP_COLORS} />}
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)' }}>{change.title}</div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {change.availableTransitions.map((tr) => {
          const colors = transitionBtnColor(tr.toStep)
          return (
            <button
              key={tr.toStep}
              disabled={transitioning}
              onClick={() => onTransition(tr)}
              style={{ padding: '8px 16px', backgroundColor: colors.bg, color: colors.color, border: 'none', borderRadius: 7, fontSize: 'var(--font-size-card-title)', fontWeight: 600, cursor: transitioning ? 'not-allowed' : 'pointer' }}
            >
              {tr.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
