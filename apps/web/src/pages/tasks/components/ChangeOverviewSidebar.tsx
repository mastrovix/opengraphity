/**
 * Right-side sidebar summarising the whole change: workflow phase badge,
 * approval-route preview, requester/owner, per-CI status dots table, and
 * (once both assessments are done) the computed scores for the current CI.
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { SectionCard } from '@/components/ui/SectionCard'
import { PhaseBadge, RiskBadge, StatusLabel } from '@/components/ui/badges'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT, ASSESSMENT_ROLE } from '@/lib/taskStatus'
import type { AffectedCI, AssessmentTaskData, ChangeData, DeployPlanTaskData } from '@/types/change'
import { colors } from '@/lib/tokens'

/**
 * `not_required`: a task the change does not have — the functional and
 * technical assessments of a pre-approved change, which asks only for the
 * plan (owner, 25 Sep 2026). A hollow dot, not a grey one: grey says «still
 * to do», and here there is nothing to do.
 */
type DotState = 'not_started' | 'in_progress' | 'completed' | 'failed' | 'not_required'
const DOT_COLOR: Record<DotState, string> = {
  not_started:  'var(--color-slate-light)',
  in_progress:  colors.warning,
  completed:    colors.success,
  failed:       'var(--color-danger)',
  not_required: 'transparent',
}

function dotStyle(state: DotState): React.CSSProperties {
  return {
    width: 8, height: 8, borderRadius: '50%', display: 'inline-block', boxSizing: 'border-box', backgroundColor: DOT_COLOR[state],
    border: state === 'not_required' ? '1px solid var(--color-slate-light)' : 'none',
  }
}

/** A change that asks this CI for no assessment: pre-approved, only the plan. */
function planOnly(a: AffectedCI): boolean {
  return !a.assessmentOwner && !a.assessmentSupport
}

function assessDotState(t: AssessmentTaskData | null, required: boolean): DotState {
  if (!t) return required ? 'not_started' : 'not_required'
  if (t.status === TASK_STATUS.COMPLETED) return 'completed'
  if (t.status === TASK_STATUS.IN_PROGRESS || t.responses.length > 0) return 'in_progress'
  return 'not_started'
}
function planDotState(t: DeployPlanTaskData | null): DotState {
  if (!t) return 'not_started'
  if (t.status === TASK_STATUS.COMPLETED) return 'completed'
  if (t.steps.length > 0) return 'in_progress'
  return 'not_started'
}
function simpleDotState(t: { status: string; result?: string | null } | null): DotState {
  if (!t) return 'not_started'
  if (t.status === TASK_STATUS.COMPLETED) {
    return (t.result === VALIDATION_RESULT.FAIL || t.result === REVIEW_RESULT.REJECTED) ? 'failed' : 'completed'
  }
  if (t.status !== TASK_STATUS.PENDING) return 'in_progress'
  return 'not_started'
}

// Ordine dei 6 pallini di stato per CI (deve combaciare con CIDots).
/** Chiavi delle sei fasi, nell'ordine dei pallini. */
const CI_PHASE_KEYS = ['changeTasks.phaseName.functional', 'changeTasks.phaseName.technical', 'changeTasks.phaseName.plan', 'changeTasks.phaseName.validation', 'changeTasks.phaseName.deploy', 'changeTasks.phaseName.review'] as const

function CIDots({ a }: { a: AffectedCI }) {
  const { t } = useTranslation()
  const states: DotState[] = [
    assessDotState(a.assessmentOwner, !planOnly(a)),
    assessDotState(a.assessmentSupport, !planOnly(a)),
    planDotState(a.deployPlan),
    simpleDotState(a.validation),
    simpleDotState(a.deployment),
    simpleDotState(a.review),
  ]
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {states.map((state, i) => (
        <span key={i} title={t(CI_PHASE_KEYS[i]!)} data-dot={state} style={dotStyle(state)} />
      ))}
    </div>
  )
}

// Legenda dei pallini: ordine delle fasi + significato dei colori.
// Utile su touch (iPad) dove il tooltip degli 8px non è raggiungibile.
function CIDotsLegend() {
  const { t } = useTranslation()
  const colorItems: Array<{ state: DotState; label: string }> = [
    { state: 'not_started', label: t('changeTasks.dot.notStarted') },
    { state: 'in_progress', label: t('changeTasks.dot.inProgress') },
    { state: 'completed',   label: t('changeTasks.dot.completed') },
    { state: 'failed',      label: t('changeTasks.dot.failed') },
    { state: 'not_required', label: t('changeTasks.dot.notRequired') },
  ]
  return (
    <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12, lineHeight: 1.6 }}>
      <div style={{ marginBottom: 4 }}>
        {t('changeTasks.dotsLegend', { phases: CI_PHASE_KEYS.map((k, i) => `${i + 1} ${t(k)}`).join(' · ') })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center' }}>
        {colorItems.map((c) => (
          <span key={c.state} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={dotStyle(c.state)} />
            {c.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function ChangeOverviewSidebar({
  change, allAffected, ciAffected, currentCIId, changeId, currentCIName,
  stepLabel, stepCategory, onRowClick,
}: {
  change: ChangeData | null
  allAffected: AffectedCI[]
  ciAffected: AffectedCI | null
  currentCIId: string
  currentCIName: string
  changeId: string
  stepLabel: string | null
  stepCategory: string | null
  onRowClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <div style={{ position: 'sticky', top: 16 }}>
      <SectionCard title={t('pages.taskView.changeOverview')} collapsible={false}>
        {change && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{change.code}</span>
              <PhaseBadge
                phase={change.workflowInstance?.currentStep ?? ''}
                label={stepLabel ?? undefined}
                category={stepCategory}
              />
            </div>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '0 0 8px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change.title}</p>
            {(change.why || change.what) && (
              <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', margin: '0 0 8px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {[change.why && t('changeTasks.whyLine', { why: change.why }), change.what && t('changeTasks.whatLine', { what: change.what })].filter(Boolean).join(' · ')}
              </p>
            )}
            <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
              {change.requester && <span>{t('changeTasks.requester')}: <strong style={{ color: 'var(--color-slate)' }}>{change.requester.name}</strong></span>}
              {change.changeOwner && <span style={{ marginLeft: 8 }}>{t('changeTasks.changeOwner')}: <strong style={{ color: 'var(--color-slate)' }}>{change.changeOwner.name}</strong></span>}
            </div>

            <div style={{ fontSize: 'var(--font-size-label)', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6 }}>{t('components.affectedCI.title')}</div>
              {allAffected.map((a) => {
                const isCurrent = a.ci.id === currentCIId
                return (
                  <button
                    type="button"
                    key={a.ci.id}
                    onClick={onRowClick}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginBottom: 2, borderRadius: 6, cursor: 'pointer',
                      width: '100%', border: 'none', font: 'inherit', color: 'inherit', textAlign: 'left',
                      background: isCurrent ? 'var(--color-brand-light)' : 'transparent',
                      borderLeft: isCurrent ? '3px solid var(--color-brand)' : '3px solid transparent',
                    }}
                  >
                    <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.ci.name}</span>
                    <CIDots a={a} />
                    {a.riskScore != null && <RiskBadge compact score={a.riskScore} />}
                  </button>
                )
              })}
              <CIDotsLegend />
            </div>

            {ciAffected && planOnly(ciAffected) && (
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
                {t('changeTasks.planOnly')}
              </div>
            )}
            {ciAffected && ciAffected.assessmentOwner?.status === TASK_STATUS.COMPLETED && ciAffected.assessmentSupport?.status === TASK_STATUS.COMPLETED && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6, fontSize: 'var(--font-size-label)' }}>
                  {t('changeTasks.assessmentAnswers', { ci: currentCIName })}
                </div>
                {[ciAffected.assessmentOwner, ciAffected.assessmentSupport].map((at, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 2 }}>
                      {at.responderRole === ASSESSMENT_ROLE.OWNER ? t('changeTasks.functional') : at.responderRole === ASSESSMENT_ROLE.SUPPORT ? t('changeTasks.technical') : at.responderRole} · {t('changeTasks.score')}: {at.score ?? '—'}
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                  {t('changeTasks.riskCI')}: {ciAffected.riskScore != null && <RiskBadge compact score={ciAffected.riskScore} />}
                </div>
              </div>
            )}
            {ciAffected && !planOnly(ciAffected) && !(ciAffected.assessmentOwner?.status === TASK_STATUS.COMPLETED && ciAffected.assessmentSupport?.status === TASK_STATUS.COMPLETED) && (
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
                {t('changeTasks.functional')}: <StatusLabel status={ciAffected.assessmentOwner?.status} /> · {t('changeTasks.technical')}: <StatusLabel status={ciAffected.assessmentSupport?.status} />
              </div>
            )}

            <Link to={`/changes/${changeId}`} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', textDecoration: 'none', fontWeight: 500 }}>
              {t('changeTasks.viewFullChange')}
            </Link>
          </>
        )}
      </SectionCard>
    </div>
  )
}
