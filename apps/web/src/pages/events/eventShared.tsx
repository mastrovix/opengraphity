/**
 * Pezzi condivisi della console allarmi (lista + dettaglio): badge di stato e
 * severità, badge "Nessun CI"/"Ambiguo", etichette del riconoscimento del CI,
 * parsing delle etichette. Un valore fuori vocabolario NON prende un colore
 * "plausibile": rosso e loggato (lookupOrError), come gli altri badge.
 * Colori: solo token (lib/eventPalette), niente esadecimali.
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Pill } from '@/components/ui/Pill'
import { lookupOrError } from '@/lib/tokens'
import { TINT_CRITICAL, TINT_WARNING, TINT_INFO, TINT_SUCCESS, TINT_NEUTRAL, TINT_FLAPPING, TINT_BROKEN, ACCENT, type Tint } from '@/lib/eventPalette'
import { EVENT_MATCH_REASONS, RESOURCE_KINDS, type MonitoringEvent, type CIHealth, type EventMatchReason, type ResourceKind } from '@/types/events'

/**
 * Etichetta di `resourceKind` ("hostname" → "Hostname"): le etichette sono le
 * stesse del mappatore (`monitoring.mapper.resourceKinds.*`). Un valore fuori
 * vocabolario (sorgente generica con un kind libero) è mostrato com'è: è il
 * dato vero, non un ripiego.
 */
export function resourceKindLabel(t: TFunction, kind: string): string {
  return (RESOURCE_KINDS as readonly string[]).includes(kind) ? t(`monitoring.mapper.resourceKinds.${kind as ResourceKind}`) : kind
}

const badgeFont = { fontSize: 'var(--font-size-label)' } as const

/** Salute del CI dal monitoraggio (`ci.health`): verde/ambra/rosso. */
const HEALTH_STYLE: Record<string, Tint> = {
  operational: TINT_SUCCESS,
  degraded:    TINT_WARNING,
  down:        TINT_CRITICAL,
}

/** firing: rosso/ambra/blu per severità; resolved verde; suppressed grigio; flapping viola. */
const FIRING_STYLE: Record<string, Tint> = {
  critical: TINT_CRITICAL,
  warning:  TINT_WARNING,
  info:     TINT_INFO,
}

const STATUS_STYLE: Record<string, Tint> = {
  resolved:   TINT_SUCCESS,
  suppressed: TINT_NEUTRAL,
  flapping:   TINT_FLAPPING,
}

export function EventStatusBadge({ status, severity }: Pick<MonitoringEvent, 'status' | 'severity'>) {
  const { t } = useTranslation()
  const s = status === 'firing'
    ? lookupOrError(FIRING_STYLE, severity, 'EVENT_FIRING_STYLE', TINT_BROKEN)
    : lookupOrError(STATUS_STYLE, status, 'EVENT_STATUS_STYLE', TINT_BROKEN)
  return (
    <Pill bg={s.bg} color={s.color} style={{ ...badgeFont, textTransform: 'uppercase' }}>
      {t(`events.status.${status}`)}
    </Pill>
  )
}

export function EventSeverityBadge({ severity }: Pick<MonitoringEvent, 'severity'>) {
  const { t } = useTranslation()
  const s = lookupOrError(FIRING_STYLE, severity, 'EVENT_SEVERITY_STYLE', TINT_BROKEN)
  return (
    <Pill bg={s.bg} color={s.color} style={{ ...badgeFont, textTransform: 'uppercase' }}>
      {t(`events.severity.${severity}`)}
    </Pill>
  )
}

/**
 * Badge grigio "Nessun CI" per gli eventi senza CI riconosciuto; con
 * `matchReason = ambiguous` diventa "Ambiguo" (ambra): più CI hanno lo stesso
 * nome e va scelto a mano. La spiegazione è collegata via aria-describedby
 * dal chiamante quando serve (dettaglio); in riga basta il badge.
 */
export function EventNoCIBadge({ matchReason }: { matchReason: EventMatchReason | null }) {
  const { t } = useTranslation()
  const ambiguous = matchReason === 'ambiguous'
  const s = ambiguous ? TINT_WARNING : TINT_NEUTRAL
  return (
    <Pill bg={s.bg} color={s.color} style={badgeFont}>
      {ambiguous
        ? <span title={t('events.matchReason.ambiguousHelp')}>{t('events.matchReason.ambiguousBadge')}</span>
        : t('events.orphan')}
    </Pill>
  )
}

/** Etichetta del riconoscimento del CI; un valore fuori vocabolario è mostrato com'è (fail-loud, non nascosto). */
export function matchReasonLabel(t: TFunction, reason: EventMatchReason | null): string {
  if (reason === null) return t('events.matchReason.unknown')
  return EVENT_MATCH_REASONS.includes(reason) ? t(`events.matchReason.${reason}`) : t('events.matchReason.unexpected', { value: String(reason) })
}

/**
 * "Salute: Operativo/Degradato/Giù" accanto allo stato del ciclo di vita del CI.
 * `compact` toglie il prefisso "Salute:" (colonna che già si chiama così).
 */
export function CIHealthBadge({ health, compact = false }: { health: CIHealth; compact?: boolean }) {
  const { t } = useTranslation()
  const s = lookupOrError(HEALTH_STYLE, health, 'CI_HEALTH_STYLE', TINT_BROKEN)
  return (
    <Pill bg={s.bg} color={s.color} style={badgeFont}>
      {compact ? t(`events.health.${health}`) : `${t('events.detail.ciHealth')}: ${t(`events.health.${health}`)}`}
    </Pill>
  )
}

/** Colore pieno della salute (striscia di riga, icone): stessa palette di HEALTH_STYLE. */
export const CI_HEALTH_ACCENT: Record<CIHealth, string> = {
  operational: ACCENT.success,
  degraded:    ACCENT.warning,
  down:        ACCENT.critical,
}

/**
 * Etichette della sorgente (JSON serializzato) → coppie chiave/valore.
 * JSON non valido → `error` valorizzato (già tradotto dove il messaggio è
 * nostro; quello del parser JSON resta com'è): il chiamante lo mostra, non lo nasconde.
 */
export function parseLabels(raw: string | null, t: TFunction): { entries: [string, string][]; error: string | null } {
  if (!raw) return { entries: [], error: null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { entries: [], error: t('errors.labelsNotObject') }
    }
    const entries = Object.entries(parsed as Record<string, unknown>)
      .map<[string, string]>(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    return { entries, error: null }
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** L'evento è ancora "vivo": accetta presa in carico e risoluzione manuale. */
export function isActiveEvent(ev: Pick<MonitoringEvent, 'status'>): boolean {
  return ev.status === 'firing' || ev.status === 'flapping'
}
