/**
 * Correlazione automatica degli eventi (Event Management, ondata 3): come
 * mostrare l'esito della policy (`Event.correlation`) in console, nel
 * dettaglio e nelle liste di incident/change.
 *
 * - `EventIncidentCell`: la colonna "Incident" — link all'incident con
 *   l'icona "automatico", oppure il chip che spiega perché NON c'è un
 *   incident (silenziato da una change, in attesa, CI da collegare).
 * - `correlationSentence`: la frase leggibile del dettaglio.
 * - `delayedOpensIn`: countdown per gli eventi in attesa del ritardo di policy.
 *
 * Un esito fuori vocabolario non viene "abbellito": la cella mostra il link o
 * il trattino e la frase dice che l'esito è sconosciuto (fail-loud).
 */
import type { MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Zap, RotateCcw, Link2, CheckCircle2 } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'
import { formatDateTime } from '@/lib/datetime'
import { colors } from '@/lib/tokens'
import { REEVALUABLE_CORRELATIONS, type MonitoringEvent, type EventPolicy, type EventCorrelation } from '@/types/events'

/** Sottoinsieme della policy che serve alla correlazione (il resto non è necessario ai chiamanti). */
export type CorrelationPolicy = Pick<EventPolicy, 'openIncidentFrom' | 'openDelaySeconds'>

type CorrelationEvent = Pick<MonitoringEvent, 'status' | 'severity' | 'incident' | 'suppressedBy' | 'correlation' | 'correlationAt'>

/** "Rivaluta ora" ha senso solo quando la policy può ancora cambiare idea. */
export function canReevaluate(ev: Pick<MonitoringEvent, 'correlation'>): boolean {
  return REEVALUABLE_CORRELATIONS.includes(ev.correlation)
}

/** Silenziato da una change in finestra: non apre incident (nemmeno a mano). */
export function isSuppressed(ev: Pick<MonitoringEvent, 'status' | 'correlation'>): boolean {
  return ev.status === 'suppressed' || ev.correlation === 'suppressed'
}

/**
 * Secondi mancanti all'apertura di un evento `delayed`: correlationAt +
 * openDelaySeconds − adesso. Null se manca la policy o l'istante di valutazione.
 */
export function delayedOpensIn(ev: Pick<MonitoringEvent, 'correlation' | 'correlationAt'>, policy: CorrelationPolicy | null | undefined, now = Date.now()): number | null {
  if (ev.correlation !== 'delayed' || !ev.correlationAt || !policy) return null
  const at = Date.parse(ev.correlationAt)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at + policy.openDelaySeconds * 1000 - now) / 1000))
}

/** Icona + tooltip per gli esiti in cui il monitoraggio ha agito da solo sull'incident. */
const AUTO_ICON: Partial<Record<EventCorrelation, { Icon: typeof Zap; key: string }>> = {
  opened:        { Icon: Zap,          key: 'events.correlation.auto.opened' },
  attached:      { Icon: Link2,        key: 'events.correlation.auto.attached' },
  reopened:      { Icon: RotateCcw,    key: 'events.correlation.auto.reopened' },
  auto_resolved: { Icon: CheckCircle2, key: 'events.correlation.auto.auto_resolved' },
}

const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const
const chipFont  = { fontSize: 'var(--font-size-label)' } as const

interface CellProps {
  event:   CorrelationEvent
  policy?: CorrelationPolicy | null
  /** Dentro una riga cliccabile: il click sul link non deve navigare la riga. */
  stopRowClick?: boolean
}

export function EventIncidentCell({ event, policy, stopRowClick = false }: CellProps) {
  const { t } = useTranslation()
  const stop = stopRowClick ? (e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation() : undefined

  if (event.incident) {
    const auto = AUTO_ICON[event.correlation]
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Link to={`/incidents/${event.incident.id}`} onClick={stop} style={linkStyle}>{event.incident.number}</Link>
        {auto && (
          <span role="img" aria-label={t(auto.key)} title={t(auto.key)} style={{ display: 'inline-flex', color: colors.slateLight }}>
            <auto.Icon size={13} aria-hidden="true" />
          </span>
        )}
      </span>
    )
  }

  switch (event.correlation) {
    case 'suppressed': {
      const chg = event.suppressedBy
      const label = chg ? t('events.correlation.chip.suppressed', { code: chg.code }) : t('events.correlation.chip.suppressedUnknown')
      const pill = <Pill bg="var(--color-slate-bg)" color="var(--color-slate)" style={chipFont}>{label}</Pill>
      return chg
        ? <Link to={`/changes/${chg.id}`} onClick={stop} title={chg.title} style={{ textDecoration: 'none' }}>{pill}</Link>
        : pill
    }
    case 'delayed': {
      const secs = delayedOpensIn(event, policy)
      const tip = secs !== null && secs > 0 ? t('events.correlation.chip.delayedIn', { seconds: secs }) : t('events.correlation.chip.delayedWaiting')
      return <Pill bg="var(--color-info-bg)" color="#1d4ed8" style={chipFont}><span title={tip}>{t('events.correlation.chip.delayed')}</span></Pill>
    }
    case 'skipped_orphan':
      return <Pill bg="#fef3c7" color="#b45309" style={chipFont}><span title={t('events.correlation.text.skipped_orphan')}>{t('events.correlation.chip.linkCI')}</span></Pill>
    default:
      return <span style={{ color: colors.slateLight }}>—</span>
  }
}

/**
 * La frase del dettaglio: cosa ha fatto la policy con l'evento. Con la policy
 * a disposizione le frasi "in attesa" e "sotto soglia" dicono anche i numeri.
 */
export function correlationSentence(t: TFunction, ev: CorrelationEvent, policy: CorrelationPolicy | null | undefined): string {
  const when   = formatDateTime(ev.correlationAt)
  const number = ev.incident?.number ?? '—'
  switch (ev.correlation) {
    case 'opened':        return t('events.correlation.text.opened', { number, when })
    case 'attached':      return t('events.correlation.text.attached', { number, when })
    case 'reopened':      return t('events.correlation.text.reopened', { number, when })
    case 'auto_resolved': return t('events.correlation.text.auto_resolved', { number, when })
    case 'suppressed':
      return ev.suppressedBy
        ? t('events.correlation.text.suppressed', { code: ev.suppressedBy.code })
        : t('events.correlation.text.suppressedUnknown')
    case 'skipped_orphan': return t('events.correlation.text.skipped_orphan')
    case 'skipped_severity':
      return policy
        ? t('events.correlation.text.skipped_severity', { severity: t(`events.severity.${ev.severity}`), from: t(`events.policy.openFrom.${policy.openIncidentFrom}`) })
        : t('events.correlation.text.skipped_severityNoPolicy', { severity: t(`events.severity.${ev.severity}`) })
    case 'delayed': {
      const remaining = delayedOpensIn(ev, policy)
      return policy && remaining !== null
        ? t('events.correlation.text.delayed', { seconds: policy.openDelaySeconds, remaining })
        : t('events.correlation.text.delayedNoPolicy')
    }
    case 'none': return t('events.correlation.text.none')
    default:     return t('events.correlation.text.unknown', { value: String(ev.correlation) })
  }
}
