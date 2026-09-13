/**
 * Change Information card: description, owner, requester, dates,
 * aggregate-risk + approval-route badges, assessment progress bar, and
 * workflow-transition buttons.
 *
 * The card is purely presentational. Transitions are surfaced as
 * `onTransitionClick(toStep, label, requiresInput, inputField)` so the
 * parent can open the notes modal or execute the transition directly.
 */
import { useTranslation } from 'react-i18next'
import { SectionCard } from '@/components/ui/SectionCard'
import { SeverityBadge } from '@/components/SeverityBadge'
import type { AvailableTransition, ChangeData } from '@/types/change'
import { DescriptionField, DetailField, RiskBadge, fmtDate } from './shared'
import { colors } from '@/lib/tokens'

export function ChangeInfoCard({
  change, currentStep, atApproval, initialStepName, isTerminal, isAdmin,
  transitioning, totalTasks, completedTasks, transitions,
  onTransitionClick, stepLabel,
}: {
  change: ChangeData
  currentStep: string
  /**
   * La change è nel passo di approvazione (SCOPO `approval`, non il nome:
   * ondata 4 · A4-3). Lo decide la pagina, che ha i metadata dei passi; la
   * card resta presentazionale.
   */
  atApproval: boolean
  initialStepName: string | null
  isTerminal: boolean
  isAdmin: boolean
  transitioning: boolean
  totalTasks: number
  completedTasks: number
  transitions: AvailableTransition[]
  stepLabel: string
  onTransitionClick: (tr: AvailableTransition) => void
}) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t('pages.changeDetail.info')} collapsible defaultOpen>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <DetailField label={t('detail.ticketNumber')} value={change.code} />
        <DetailField label={t('common.title')} value={change.title} />
        {change.why  && <DescriptionField label={t('pages.changeDetail.why')} value={change.why} />}
        {change.what && <DescriptionField label={t('pages.changeDetail.what')} value={change.what} />}
        {change.changeOwner && <DetailField label={t('pages.changeDetail.changeOwner')} value={change.changeOwner.name} />}
        {change.requester && <DetailField label={t('pages.changeDetail.requester')} value={change.requester.name} />}
        <DetailField label={t('detail.createdAt')} value={fmtDate(change.createdAt)} />
        <DetailField label={t('detail.updatedAt')} value={fmtDate(change.updatedAt)} />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {change.priority && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, lineHeight: 1 }}>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('detail.priority')}</span>
            <SeverityBadge value={change.priority} />
          </span>
        )}
        {change.aggregateRiskScore != null && <RiskBadge score={change.aggregateRiskScore} />}
        {currentStep === initialStepName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 180 }}>
            <div style={{ height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden', flex: 1 }}>
              <div style={{ height: '100%', width: `${totalTasks > 0 ? Math.round(completedTasks / totalTasks * 100) : 0}%`, backgroundColor: 'var(--color-brand)', borderRadius: 3, transition: 'width 200ms' }} />
            </div>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', flexShrink: 0 }}>{t('pages.changeDetail.tasksDone', { done: completedTasks, total: totalTasks })}</span>
          </div>
        )}
        {isAdmin && !atApproval && transitions.map((tr) => (
          <button
            key={tr.toStep}
            type="button"
            disabled={transitioning}
            onClick={() => onTransitionClick(tr)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none',
              background: 'var(--color-brand)', color: colors.white, fontWeight: 600,
              cursor: transitioning ? 'wait' : 'pointer', fontSize: 'var(--font-size-label)',
            }}
          >
            {tr.label}
          </button>
        ))}
        {isTerminal && <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-success)', fontWeight: 600 }}>{t('changeTasks.doneMark')}</span>}
        {transitions.length === 0 && currentStep && !isTerminal && (
          <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1, fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>{t('pages.changeDetail.stepInProgress', { step: stepLabel })}</span>
        )}
      </div>
    </SectionCard>
  )
}
