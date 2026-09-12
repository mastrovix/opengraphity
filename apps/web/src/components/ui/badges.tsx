/**
 * Badge di dominio, tutti costruiti sul primitivo Pill.
 *
 * Prima: SeverityBadge era testo grigio (critical e low identici), RiskBadge
 * esisteva due volte con la stessa palette da tenere allineata a mano,
 * PhaseBadge e StatusLabel vivevano in pagine diverse.
 *
 * Ondata 7 · D-15 — «niente fallback silenziosi» resta la regola, ma va
 * applicata al caso giusto. Un valore che il CLIENTE ha aggiunto al suo
 * vocabolario (`blocker` in `severity`) non è un difetto: prende uno stile
 * neutro e la sua etichetta. Un valore **fuori** dal vocabolario del cliente
 * sì, e resta rosso con `console.error`. La distinzione la fa
 * `lib/domainStyle.ts`, con il vocabolario letto da `useDomainVocabulary`.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/ui/Pill'
import { lookupOrError, colors, palette } from '@/lib/tokens'
import { domainValueStyle } from '@/lib/domainStyle'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { enumLabel } from '@/lib/ciEnums'
import { styleForCategory } from '@/lib/workflowStepStyle'
import { TASK_STATUS, REVIEW_RESULT } from '@/lib/taskStatus'

const BROKEN = { bg: 'var(--color-danger)', color: colors.white }

// ── Severità / priorità (incident, problem, change) ─────────────────────────

/** Palette severità UNICA (incident, problem, anomalie, impatto what-if): niente copie locali. */
export const SEVERITY_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: palette.danger.tint, color: palette.danger.text },
  high:     { bg: palette.orange.tint, color: palette.orange.text },
  medium:   { bg: palette.warning.tint, color: palette.warning.text },
  low:      { bg: palette.success.tint, color: palette.success.text },
}

/**
 * `vocabulary` = il nome del vocabolario a cui il valore appartiene. Di norma
 * `severity`; chi mostra una priorità con questa palette passa `priority`.
 * Un valore del vocabolario senza stile è neutro, uno fuori vocabolario è
 * rosso (D-15).
 */
export function SeverityBadge({ value, vocabulary = 'severity' }: { value: string | null | undefined; vocabulary?: string }) {
  const { valuesOf } = useDomainVocabularies()
  if (!value) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const s = domainValueStyle(SEVERITY_STYLE, value, `SEVERITY_STYLE/${vocabulary}`, valuesOf(vocabulary))
  return <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase' }}>{enumLabel(value)}</Pill>
}

// ── Ruolo utente (admin / operator / viewer / end_user) ─────────────────────

/** Stessi 4 ruoli accettati dall'API (`UserRole` in hooks/useMe.ts); etichette in `roles.*`. */
const ROLE_STYLE: Record<string, { bg: string; color: string; labelKey: string }> = {
  admin:    { bg: 'var(--color-danger-bg)', color: 'var(--color-trigger-sla-breach)', labelKey: 'roles.admin' },
  operator: { bg: 'var(--color-info-bg)',   color: colors.brand,                          labelKey: 'roles.operator' },
  viewer:   { bg: 'var(--color-slate-bg)',  color: 'var(--color-slate)',               labelKey: 'roles.viewer' },
  end_user: { bg: palette.purple.bg,                color: palette.purple.dark,                          labelKey: 'roles.end_user' },
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

/**
 * D-15, e perché questa palette NON passa da `domainValueStyle`: la chiave non
 * è un valore di dominio ma l'esito di `riskLevel(score)`, che restituisce
 * sempre una di queste tre. Non esiste il caso «valore del cliente senza
 * stile». (Le soglie sono l'altro mezzo punto di D-15 e vivono nel
 * `riskScore` dell'API: le rende configurabili l'agente A.)
 */
const RISK_STYLE: Record<string, { bg: string; color: string; labelKey: string }> = {
  low:    { bg: palette.success.tint, color: palette.success.text, labelKey: 'risk.low' },
  medium: { bg: palette.warning.tint, color: palette.warning.text, labelKey: 'risk.medium' },
  high:   { bg: palette.danger.tint, color: palette.danger.text, labelKey: 'risk.high' },
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
    s === 'failed' || s === REVIEW_RESULT.REJECTED ? 'var(--color-danger)' : colors.slateLight
  const label = s === TASK_STATUS.PENDING ? t('taskStatus.toBeCompleted') : s.replace(/_/g, ' ')
  return <strong title={s} style={{ color, textTransform: 'uppercase' }}>{label}</strong>
}
