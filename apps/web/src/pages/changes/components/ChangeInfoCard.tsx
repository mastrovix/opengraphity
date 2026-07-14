/**
 * Change Information card: description, owner, requester, dates,
 * aggregate-risk + approval-route badges, assessment progress bar, and
 * workflow-transition buttons.
 *
 * The card is purely presentational. Transitions are surfaced as
 * `onTransitionClick(toStep, label, requiresInput, inputField)` so the
 * parent can open the notes modal or execute the transition directly.
 */
import { SectionCard } from '@/components/ui/SectionCard'
import { Pill } from '@/components/ui/Pill'
import type { AvailableTransition, ChangeData } from '@/types/change'
import { DescriptionField, DetailField, RiskBadge, fmtDate } from './shared'

export function ChangeInfoCard({
  change, currentStep, initialStepName, isTerminal, isAdmin,
  transitioning, liveRoute, totalTasks, completedTasks, transitions,
  onTransitionClick, stepLabel,
}: {
  change: ChangeData
  currentStep: string
  initialStepName: string | null
  isTerminal: boolean
  isAdmin: boolean
  transitioning: boolean
  liveRoute: { label: string; color: string; bg: string }
  totalTasks: number
  completedTasks: number
  transitions: AvailableTransition[]
  stepLabel: string
  onTransitionClick: (tr: AvailableTransition) => void
}) {
  return (
    <SectionCard title="Change Information" collapsible defaultOpen>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <DetailField label="Titolo" value={change.title} />
        {change.description && <DescriptionField value={change.description} />}
        {change.changeOwner && <DetailField label="Change Owner" value={change.changeOwner.name} />}
        {change.requester && <DetailField label="Requester" value={change.requester.name} />}
        <DetailField label="Creato il" value={fmtDate(change.createdAt)} />
        <DetailField label="Aggiornato il" value={fmtDate(change.updatedAt)} />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {change.aggregateRiskScore != null && <RiskBadge score={change.aggregateRiskScore} />}
        {liveRoute.label !== '— da calcolare —' && (
          <Pill bg={liveRoute.bg} color={liveRoute.color} style={{ padding: '3px 10px', fontSize: 'var(--font-size-label)' }}>{liveRoute.label}</Pill>
        )}
        {currentStep === initialStepName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 180 }}>
            <div style={{ height: 6, borderRadius: 3, backgroundColor: '#e5e7eb', overflow: 'hidden', flex: 1 }}>
              <div style={{ height: '100%', width: `${totalTasks > 0 ? Math.round(completedTasks / totalTasks * 100) : 0}%`, backgroundColor: 'var(--color-brand)', borderRadius: 3, transition: 'width 200ms' }} />
            </div>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', flexShrink: 0 }}>{completedTasks}/{totalTasks} task completati</span>
          </div>
        )}
        {isAdmin && transitions.map((tr) => (
          <button
            key={tr.toStep}
            type="button"
            disabled={transitioning}
            onClick={() => onTransitionClick(tr)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none',
              background: 'var(--color-brand)', color: '#fff', fontWeight: 600,
              cursor: transitioning ? 'wait' : 'pointer', fontSize: 'var(--font-size-label)',
            }}
          >
            {tr.label}
          </button>
        ))}
        {isTerminal && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-success)', fontWeight: 600 }}>✓ Completato</span>}
        {transitions.length === 0 && currentStep && !isTerminal && (
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{stepLabel} in corso</span>
        )}
      </div>
    </SectionCard>
  )
}
