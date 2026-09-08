/**
 * Badge di dominio, tutti costruiti sul primitivo Pill.
 *
 * Prima: SeverityBadge era testo grigio (critical e low identici), RiskBadge
 * esisteva due volte con la stessa palette da tenere allineata a mano,
 * PhaseBadge e StatusLabel vivevano in pagine diverse. Un valore fuori dalla
 * tavolozza NON prende un default benigno: si vede (rosso "?"), coerentemente
 * con la regola "niente fallback silenziosi".
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/ui/Pill'
import { lookupOrError } from '@/lib/tokens'
import { styleForCategory } from '@/lib/workflowStepStyle'
import { TASK_STATUS, REVIEW_RESULT } from '@/lib/taskStatus'

const BROKEN = { bg: 'var(--color-danger)', color: '#fff' }

// ── Severità / priorità (incident, problem, change) ─────────────────────────

/** Palette severità UNICA (incident, problem, anomalie, impatto what-if): niente copie locali. */
export const SEVERITY_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fee2e2', color: '#b91c1c' },
  high:     { bg: '#ffedd5', color: '#c2410c' },
  medium:   { bg: '#fef3c7', color: '#b45309' },
  low:      { bg: '#dcfce7', color: '#15803d' },
}

export function SeverityBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const s = lookupOrError(SEVERITY_STYLE, value, 'SEVERITY_STYLE', BROKEN)
  return <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase' }}>{value}</Pill>
}

// ── Ruolo utente (admin / operator / viewer / end_user) ─────────────────────

/** Stessi 4 ruoli accettati dall'API (`UserRole` in hooks/useMe.ts); etichette in `roles.*`. */
const ROLE_STYLE: Record<string, { bg: string; color: string; labelKey: string }> = {
  admin:    { bg: 'var(--color-danger-bg)', color: 'var(--color-trigger-sla-breach)', labelKey: 'roles.admin' },
  operator: { bg: 'var(--color-info-bg)',   color: '#2563eb',                          labelKey: 'roles.operator' },
  viewer:   { bg: 'var(--color-slate-bg)',  color: 'var(--color-slate)',               labelKey: 'roles.viewer' },
  end_user: { bg: '#f5f3ff',                color: '#6d28d9',                          labelKey: 'roles.end_user' },
}

export function RoleBadge({ role }: { role: string | null | undefined }) {
  const { t } = useTranslation()
  if (!role) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const s = lookupOrError(ROLE_STYLE, role, 'ROLE_STYLE', { ...BROKEN, labelKey: '' })
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'var(--font-size-body)' }}>
      {s.labelKey ? t(s.labelKey) : role}
    </Pill>
  )
}

// ── Rischio aggregato della change ───────────────────────────────────────────

const RISK_STYLE: Record<string, { bg: string; color: string; labelKey: string }> = {
  low:    { bg: '#dcfce7', color: '#15803d', labelKey: 'risk.low' },
  medium: { bg: '#fef3c7', color: '#b45309', labelKey: 'risk.medium' },
  high:   { bg: '#fee2e2', color: '#b91c1c', labelKey: 'risk.high' },
}

/** Stesse soglie del backend (scoring.ts): ≤30 low, ≤60 medium, >60 high. */
export function riskLevel(score: number): 'low' | 'medium' | 'high' {
  return score <= 30 ? 'low' : score <= 60 ? 'medium' : 'high'
}

/** `compact`: solo il numero (tabelle strette, sidebar). */
export function RiskBadge({ score, compact = false }: { score: number | null | undefined; compact?: boolean }) {
  const { t } = useTranslation()
  if (score == null) return <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)' }}>—</span>
  const p = lookupOrError(RISK_STYLE, riskLevel(score), 'RISK_STYLE', { ...BROKEN, labelKey: '' })
  const label = p.labelKey ? t(p.labelKey) : '?'
  return (
    <Pill bg={p.bg} color={p.color} style={{ fontSize: 'var(--font-size-label)', flexShrink: 0 }}>
      <span title={`${label} · score ${score}`}>{compact ? score : `${label} · ${score}`}</span>
    </Pill>
  )
}

// ── Fase del workflow (per categoria dello step) ────────────────────────────

export function PhaseBadge({ phase, label, category, style }: {
  phase: string; label?: string; category?: string | null; style?: React.CSSProperties
}) {
  const s = styleForCategory(category)
  return (
    <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'capitalize', whiteSpace: 'normal', ...style }}>
      {label || phase}
    </Pill>
  )
}

// ── Stato di un task della change ────────────────────────────────────────────

export function StatusLabel({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation()
  const s = status ?? '—'
  const color =
    s === TASK_STATUS.COMPLETED   ? 'var(--color-success)' :
    s === TASK_STATUS.IN_PROGRESS ? 'var(--color-warning)' :
    s === TASK_STATUS.PENDING     ? 'var(--color-danger)' :
    s === 'failed' || s === REVIEW_RESULT.REJECTED ? 'var(--color-danger)' : '#d1d5db'
  const label = s === TASK_STATUS.PENDING ? t('taskStatus.toBeCompleted') : s.replace(/_/g, ' ')
  return <strong title={s} style={{ color, textTransform: 'uppercase' }}>{label}</strong>
}
