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
 * `lib/domainStyle.ts`, con vocabolario e colori letti da `useDomainVocabularies`.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/ui/Pill'
import { colors, palette } from '@/lib/tokens'
import { useCallback } from 'react'
import { vocabularyValueStyle, NEUTRAL_VALUE_STYLE, type ValueStyle } from '@/lib/domainStyle'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useRiskBands } from '@/contexts/RiskBandContext'
import { enumLabel } from '@/lib/ciEnums'
import { styleForCategory } from '@/lib/workflowStepStyle'
import { TASK_STATUS, REVIEW_RESULT } from '@/lib/taskStatus'


// ── Severità / priorità (incident, problem, change) ─────────────────────────

/**
 * `vocabulary` = il nome del vocabolario a cui il valore appartiene. Di norma
 * `severity`; chi mostra una priorità passa `priority`. Il colore è quello del
 * Dizionario del cliente (revisione del 14 set 2026 · F9): prima era
 * `SEVERITY_STYLE`, scritto qui. Un valore del vocabolario senza colore è
 * neutro, uno fuori vocabolario è rosso (D-15).
 */
export function SeverityBadge({ value, vocabulary = 'severity' }: { value: string | null | undefined; vocabulary?: string }) {
  const { valuesOf, labelOf, colorOf } = useDomainVocabularies()
  if (!value) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const s = vocabularyValueStyle(vocabulary, value, valuesOf(vocabulary), colorOf(vocabulary, value))
  // L'ETICHETTA del cliente («Critica»), e finché non la conosciamo il valore
  // con le iniziali maiuscole, come prima. Il `title` porta sempre il valore:
  // è quello che si cerca nei filtri e che si trova nei log.
  return (
    <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase' }} title={value}>
      {labelOf(vocabulary, value) ?? enumLabel(value)}
    </Pill>
  )
}

// ── Ruolo utente (admin / operator / viewer / end_user) ─────────────────────

/**
 * I ruoli di fabbrica hanno colore ed etichetta propri (`roles.*`); un ruolo
 * creato dall'organizzazione (ondata 7) ha il suo nome e il colore neutro del
 * brand. `name` è il nome scelto dall'organizzazione, anche per un ruolo di
 * fabbrica rinominato.
 */
const ROLE_STYLE: Record<string, { bg: string; color: string; labelKey: string }> = {
  admin:    { bg: 'var(--color-danger-bg)', color: 'var(--color-trigger-sla-breach)', labelKey: 'roles.admin' },
  operator: { bg: 'var(--color-info-bg)',   color: colors.brand,                          labelKey: 'roles.operator' },
  viewer:   { bg: 'var(--color-slate-bg)',  color: 'var(--color-slate)',               labelKey: 'roles.viewer' },
  end_user: { bg: palette.purple.bg,                color: palette.purple.dark,                          labelKey: 'roles.end_user' },
}

const CUSTOM_ROLE_STYLE = { bg: 'var(--color-brand-light)', color: colors.brandHover }

export function RoleBadge({ role, name }: { role: string | null | undefined; name?: string | null }) {
  const { t } = useTranslation()
  if (!role) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
  const factory = ROLE_STYLE[role]
  const s = factory ?? CUSTOM_ROLE_STYLE
  return (
    <Pill bg={s.bg} color={s.color} radius={4} style={{ fontSize: 'var(--font-size-body)' }}>
      {name ?? (factory ? t(factory.labelKey) : role)}
    </Pill>
  )
}

// ── Rischio aggregato della change ───────────────────────────────────────────

/**
 * La FASCIA del punteggio è quella del cliente: soglie e nomi da Matrici di
 * dominio (`useRiskBands`), etichetta e colore dal Dizionario (vocabolario
 * `risk_band`). Prima erano tre livelli fissi (≤30 low, ≤60 medium, oltre high)
 * con una palette propria: con soglie diverse, o quattro fasce, la priorità
 * della change seguiva il cliente e il badge diceva altro (verifica «Cosa resta
 * cablato», ondata 1).
 *
 * Finché le soglie non si conoscono (caricamento, errore) il badge mostra il
 * solo punteggio, neutro: una fascia indovinata sarebbe la stessa scelta
 * silenziosa di prima.
 */
/**
 * Lo stile della fascia di un punteggio (per chi non usa la pastiglia, come il
 * cerchio del punteggio in What-if), o `null` se le soglie non si conoscono.
 */
export function useRiskScoreStyle(): (score: number) => ValueStyle | null {
  const { bandOf } = useRiskBands()
  const { valuesOf, colorOf } = useDomainVocabularies()
  return useCallback((score: number) => {
    const band = bandOf(score)
    return band === null ? null : vocabularyValueStyle(RISK_BAND_VOCABULARY, band, valuesOf(RISK_BAND_VOCABULARY), colorOf(RISK_BAND_VOCABULARY, band))
  }, [bandOf, valuesOf, colorOf])
}

export function RiskBadge({ score, compact = false }: { score: number | null | undefined; compact?: boolean }) {
  const { bandOf } = useRiskBands()
  const { valuesOf, labelOf, colorOf } = useDomainVocabularies()
  if (score == null) return <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)' }}>—</span>
  const band = bandOf(score)
  if (band === null) {
    return (
      <Pill bg={NEUTRAL_VALUE_STYLE.bg} color={NEUTRAL_VALUE_STYLE.color} style={{ fontSize: 'var(--font-size-label)', flexShrink: 0 }}>
        <span title={`score ${score}`}>{score}</span>
      </Pill>
    )
  }
  const s = vocabularyValueStyle(RISK_BAND_VOCABULARY, band, valuesOf(RISK_BAND_VOCABULARY), colorOf(RISK_BAND_VOCABULARY, band))
  const label = (labelOf(RISK_BAND_VOCABULARY, band) ?? enumLabel(band)).toUpperCase()
  return (
    <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', flexShrink: 0 }}>
      <span title={`${label} · score ${score}`}>{compact ? score : `${label} · ${score}`}</span>
    </Pill>
  )
}

/** Il vocabolario delle fasce di rischio (quello di `Tenant.risk_band_thresholds`). */
export const RISK_BAND_VOCABULARY = 'risk_band'

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
