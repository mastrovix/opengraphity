/**
 * Right-side sidebar summarising the whole change: workflow phase badge,
 * approval-route preview, requester/owner, per-CI status dots table, and
 * (once both assessments are done) the computed scores for the current CI.
 */
import { Link } from 'react-router-dom'
import { SectionCard } from '@/components/ui/SectionCard'
import { PhaseBadge, RiskBadge } from '@/components/ui/badges'
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

// Ordine dei 6 pallini di stato per CI (deve combaciare con CIDots).
const CI_PHASE_LABELS = ['Functional', 'Technical', 'Piano', 'Validation', 'Deploy', 'Review'] as const

function CIDots({ a }: { a: AffectedCI }) {
  const states: DotState[] = [
    assessDotState(a.assessmentOwner),
    assessDotState(a.assessmentSupport),
    planDotState(a.deployPlan),
    simpleDotState(a.validation),
    simpleDotState(a.deployment),
    simpleDotState(a.review),
  ]
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {states.map((state, i) => (
        <span key={i} title={CI_PHASE_LABELS[i]} style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: DOT_COLOR[state], display: 'inline-block' }} />
      ))}
    </div>
  )
}

// Legenda dei pallini: ordine delle fasi + significato dei colori.
// Utile su touch (iPad) dove il tooltip degli 8px non è raggiungibile.
function CIDotsLegend() {
  const colorItems: Array<{ state: DotState; label: string }> = [
    { state: 'not_started', label: 'non iniziato' },
    { state: 'in_progress', label: 'in corso' },
    { state: 'completed',   label: 'completato' },
    { state: 'failed',      label: 'fallito' },
  ]
  return (
    <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12, lineHeight: 1.6 }}>
      <div style={{ marginBottom: 4 }}>
        Pallini (in ordine): {CI_PHASE_LABELS.map((l, i) => `${i + 1} ${l}`).join(' · ')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center' }}>
        {colorItems.map((c) => (
          <span key={c.state} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: DOT_COLOR[c.state], display: 'inline-block' }} />
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
            </div>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: '0 0 8px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change.title}</p>
            {(change.why || change.what) && (
              <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', margin: '0 0 8px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {[change.why && `Perché: ${change.why}`, change.what && `Cosa: ${change.what}`].filter(Boolean).join(' · ')}
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
                    {a.riskScore != null && <RiskBadge compact score={a.riskScore} />}
                  </div>
                )
              })}
              <CIDotsLegend />
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
                  Risk CI: {ciAffected.riskScore != null && <RiskBadge compact score={ciAffected.riskScore} />}
                </div>
              </div>
            )}
            {ciAffected && !(ciAffected.assessmentOwner?.status === TASK_STATUS.COMPLETED && ciAffected.assessmentSupport?.status === TASK_STATUS.COMPLETED) && (
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginBottom: 12 }}>
                Functional: {ciAffected.assessmentOwner?.status ?? '—'} · Technical: {ciAffected.assessmentSupport?.status ?? '—'}
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
