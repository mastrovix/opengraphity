/**
 * Right-side sidebar summarising the whole change: workflow phase badge,
 * approval-route preview, requester/owner, per-CI status dots table, and
 * (once both assessments are done) the computed scores for the current CI.
 */
import { Link } from 'react-router-dom'
import { SectionCard } from '@/components/ui/SectionCard'
import { styleForCategory } from '@/lib/workflowStepStyle'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT, ROLE_LABEL } from '@/lib/taskStatus'
import type { AffectedCI, AssessmentTaskData, ChangeData, DeployPlanTaskData } from '@/types/change'

type DotState = 'not_started' | 'in_progress' | 'completed' | 'failed'
const DOT_COLOR: Record<DotState, string> = {
  not_started: 'var(--color-slate-light)',
  in_progress: '#eab308',
  completed:   '#22c55e',
  failed:      'var(--color-danger)',
}

function assessDotState(t: AssessmentTaskData | null): DotState {
  if (!t) return 'not_started'
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

function CIDots({ a }: { a: AffectedCI }) {
  const dots: Array<{ label: string; state: DotState }> = [
    { label: 'Functional',  state: assessDotState(a.assessmentOwner) },
    { label: 'Technical',   state: assessDotState(a.assessmentSupport) },
    { label: 'Piano',       state: planDotState(a.deployPlan) },
    { label: 'Validation',  state: simpleDotState(a.validation) },
    { label: 'Deploy',      state: simpleDotState(a.deployment) },
    { label: 'Review',      state: simpleDotState(a.review) },
  ]
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {dots.map((d, i) => (
        <span key={i} title={d.label} style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: DOT_COLOR[d.state], display: 'inline-block' }} />
      ))}
    </div>
  )
}

function PhaseBadge({ phase, label, category }: { phase: string; label?: string; category?: string | null }) {
  const s = styleForCategory(category)
  return (
    <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: s.bg, color: s.color, textTransform: 'capitalize' }}>
      {label || phase}
    </span>
  )
}

function RiskBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return null
  const p = score <= 30 ? { bg: '#dcfce7', color: '#15803d' } : score <= 60 ? { bg: '#fef3c7', color: '#b45309' } : { bg: '#fee2e2', color: '#b91c1c' }
  return <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: p.bg, color: p.color }}>{score}</span>
}

export function ChangeOverviewSidebar({
  change, allAffected, ciAffected, currentCIId, changeId, currentCIName,
  stepLabel, stepCategory, liveRoute, onRowClick,
}: {
  change: ChangeData | null
  allAffected: AffectedCI[]
  ciAffected: AffectedCI | null
  currentCIId: string
  currentCIName: string
  changeId: string
  stepLabel: string | null
  stepCategory: string | null
  liveRoute: { label: string; color: string; bg: string }
  onRowClick: () => void
}) {
  return (
    <div style={{ position: 'sticky', top: 16 }}>
      <SectionCard title="Overview Change" collapsible={false}>
        {change && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{change.code}</span>
              <PhaseBadge
                phase={change.workflowInstance?.currentStep ?? ''}
                label={stepLabel ?? undefined}
                category={stepCategory}
              />
              <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 'var(--font-size-label)', fontWeight: 600, backgroundColor: liveRoute.bg, color: liveRoute.color }}>{liveRoute.label}</span>
            </div>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '0 0 8px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change.title}</p>
            {change.description && (
              <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', margin: '0 0 8px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {change.description}
              </p>
            )}
            <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
              {change.requester && <span>Requester: <strong style={{ color: 'var(--color-slate)' }}>{change.requester.name}</strong></span>}
              {change.changeOwner && <span style={{ marginLeft: 8 }}>Owner: <strong style={{ color: 'var(--color-slate)' }}>{change.changeOwner.name}</strong></span>}
            </div>

            <div style={{ fontSize: 'var(--font-size-label)', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6 }}>CI Affected</div>
              {allAffected.map((a) => {
                const isCurrent = a.ci.id === currentCIId
                return (
                  <div
                    key={a.ci.id}
                    onClick={onRowClick}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginBottom: 2, borderRadius: 6, cursor: 'pointer',
                      background: isCurrent ? 'var(--color-brand-light)' : 'transparent',
                      borderLeft: isCurrent ? '3px solid var(--color-brand)' : '3px solid transparent',
                    }}
                  >
                    <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.ci.name}</span>
                    <CIDots a={a} />
                    <RiskBadge score={a.riskScore} />
                  </div>
                )
              })}
            </div>

            {ciAffected && ciAffected.assessmentOwner?.status === TASK_STATUS.COMPLETED && ciAffected.assessmentSupport?.status === TASK_STATUS.COMPLETED && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', marginBottom: 6, fontSize: 'var(--font-size-label)' }}>
                  Risposte Assessment · {currentCIName}
                </div>
                {[ciAffected.assessmentOwner, ciAffected.assessmentSupport].map((at, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', marginBottom: 2 }}>
                      {ROLE_LABEL[at.responderRole] ?? at.responderRole} · Score: {at.score ?? '—'}
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                  Risk CI: <RiskBadge score={ciAffected.riskScore} />
                </div>
              </div>
            )}
            {ciAffected && !(ciAffected.assessmentOwner?.status === TASK_STATUS.COMPLETED && ciAffected.assessmentSupport?.status === TASK_STATUS.COMPLETED) && (
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
                Owner: {ciAffected.assessmentOwner?.status ?? '—'} · Support: {ciAffected.assessmentSupport?.status ?? '—'}
              </div>
            )}

            <Link to={`/changes/${changeId}`} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', textDecoration: 'none', fontWeight: 500 }}>
              Vedi change completo →
            </Link>
          </>
        )}
      </SectionCard>
    </div>
  )
}
