/**
 * Pezzi condivisi della console eventi (lista + dettaglio): badge di stato e
 * severità, parsing delle etichette. Un valore fuori vocabolario NON prende un
 * colore "plausibile": rosso e loggato (lookupOrError), come gli altri badge.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/ui/Pill'
import { lookupOrError } from '@/lib/tokens'
import type { MonitoringEvent, CIHealth } from '@/types/events'

const BROKEN = { bg: 'var(--color-danger)', color: '#fff' }

/** Salute del CI dal monitoraggio (`ci.health`): verde/ambra/rosso. */
const HEALTH_STYLE: Record<string, { bg: string; color: string }> = {
  operational: { bg: '#dcfce7', color: '#15803d' },
  degraded:    { bg: '#fef3c7', color: '#b45309' },
  down:        { bg: '#fee2e2', color: '#b91c1c' },
}

/** firing: rosso/ambra/blu per severità; resolved verde; suppressed grigio; flapping viola. */
const FIRING_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: '#fee2e2', color: '#b91c1c' },
  warning:  { bg: '#fef3c7', color: '#b45309' },
  info:     { bg: '#dbeafe', color: '#1d4ed8' },
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  resolved:   { bg: '#dcfce7',             color: '#15803d' },
  suppressed: { bg: 'var(--color-slate-bg)', color: 'var(--color-slate)' },
  flapping:   { bg: '#f5f3ff',             color: '#6d28d9' },
}

export function EventStatusBadge({ status, severity }: Pick<MonitoringEvent, 'status' | 'severity'>) {
  const { t } = useTranslation()
  const s = status === 'firing'
    ? lookupOrError(FIRING_STYLE, severity, 'EVENT_FIRING_STYLE', BROKEN)
    : lookupOrError(STATUS_STYLE, status, 'EVENT_STATUS_STYLE', BROKEN)
  return (
    <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase' }}>
      {t(`events.status.${status}`)}
    </Pill>
  )
}

export function EventSeverityBadge({ severity }: Pick<MonitoringEvent, 'severity'>) {
  const { t } = useTranslation()
  const s = lookupOrError(FIRING_STYLE, severity, 'EVENT_SEVERITY_STYLE', BROKEN)
  return (
    <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase' }}>
      {t(`events.severity.${severity}`)}
    </Pill>
  )
}

/**
 * "Salute: Operativo/Degradato/Giù" accanto allo stato del ciclo di vita del CI.
 * `compact` toglie il prefisso "Salute:" (colonna che già si chiama così).
 */
export function CIHealthBadge({ health, compact = false }: { health: CIHealth; compact?: boolean }) {
  const { t } = useTranslation()
  const s = lookupOrError(HEALTH_STYLE, health, 'CI_HEALTH_STYLE', BROKEN)
  return (
    <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)' }}>
      {compact ? t(`events.health.${health}`) : `${t('events.detail.ciHealth')}: ${t(`events.health.${health}`)}`}
    </Pill>
  )
}

/** Colore pieno della salute (striscia di riga, icone): stessa palette di HEALTH_STYLE. */
export const CI_HEALTH_ACCENT: Record<CIHealth, string> = {
  operational: '#15803d',
  degraded:    '#b45309',
  down:        '#b91c1c',
}

/**
 * Etichette della sorgente (JSON serializzato) → coppie chiave/valore.
 * JSON non valido → `error` valorizzato: il chiamante lo mostra, non lo nasconde.
 */
export function parseLabels(raw: string | null): { entries: [string, string][]; error: string | null } {
  if (!raw) return { entries: [], error: null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { entries: [], error: 'labels: atteso un oggetto JSON' }
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
