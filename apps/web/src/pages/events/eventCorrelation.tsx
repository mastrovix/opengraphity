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
 * Ondata 4: gli esiti `flapping` (chip viola "Instabile · N passaggi/24h"),
 * `storm` (chip ambra "Tempesta · INC-…" con link) e `storm_no_ci`.
 *
 * Un esito fuori vocabolario non viene "abbellito": la cella mostra il link o
 * il trattino e la frase dice che l'esito è sconosciuto (fail-loud).
 *
 * Accessibilità: il dettaglio di ogni chip (motivo dell'attesa, sorgente della
 * tempesta, invito a collegare un CI) non sta solo nel `title`: è un testo
 * nascosto collegato con `aria-describedby`, quindi letto da tastiera e screen
 * reader; il countdown "tra N s" è visibile sotto il chip.
 */
import { useId, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Zap, RotateCcw, Link2, CheckCircle2 } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'
import { formatDateTime } from '@/lib/datetime'
import { colors } from '@/lib/tokens'
import { srOnlyStyle } from '@/lib/a11y'
import { TINT_INFO, TINT_WARNING, TINT_NEUTRAL, TINT_FLAPPING, type Tint } from '@/lib/eventPalette'
import { REEVALUABLE_CORRELATIONS, type MonitoringEvent, type EventPolicy, type EventCorrelation } from '@/types/events'

/** Sottoinsieme della policy che serve alla correlazione (il resto non è necessario ai chiamanti). */
export type CorrelationPolicy = Pick<EventPolicy, 'openIncidentFrom' | 'openDelaySeconds' | 'flapStableMinutes'>

type CorrelationEvent = Pick<MonitoringEvent, 'status' | 'severity' | 'incident' | 'suppressedBy' | 'correlation' | 'correlationAt' | 'flappingSince' | 'transitions24h' | 'source'>

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
/** Stessa palette dei badge di stato (eventShared): viola = sfarfallio, ambra = tempesta. */
const FLAP_CHIP  = TINT_FLAPPING
const STORM_CHIP = TINT_WARNING

/**
 * Chip con descrizione accessibile: `hint` è nel `title` (mouse) E in un testo
 * nascosto collegato con `aria-describedby` (tastiera, screen reader, touch).
 * `note` è un testo breve visibile sotto il chip (es. "tra 42 s").
 */
function HintedChip({ tint, label, hint, note, to, onLinkClick }: {
  tint: Tint; label: ReactNode; hint: string; note?: string | null
  /** Con `to` il solo chip diventa un link (il testo nascosto resta fuori dal nome del link). */
  to?: string; onLinkClick?: (e: MouseEvent<HTMLAnchorElement>) => void
}) {
  const hintId = useId()
  const pill = (
    <Pill bg={tint.bg} color={tint.color} style={chipFont}>
      <span title={hint} aria-describedby={hintId}>{label}</span>
    </Pill>
  )
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      {to ? <Link to={to} onClick={onLinkClick} style={{ textDecoration: 'none' }}>{pill}</Link> : pill}
      <span id={hintId} style={srOnlyStyle}>{hint}</span>
      {note && <span style={{ fontSize: 'var(--font-size-caption)', color: colors.slate, lineHeight: 1.2 }}>{note}</span>}
    </span>
  )
}

interface CellProps {
  event:   CorrelationEvent
  policy?: CorrelationPolicy | null
  /** Dentro una riga cliccabile: il click sul link non deve navigare la riga. */
  stopRowClick?: boolean
}

export function EventIncidentCell({ event, policy, stopRowClick = false }: CellProps) {
  const { t } = useTranslation()
  const stop = stopRowClick ? (e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation() : undefined

  // Sfarfallio e tempesta vengono PRIMA del link all'incident: l'esito della
  // policy è l'informazione che conta, l'incident (se c'è) resta accanto.
  switch (event.correlation) {
    case 'flapping': {
      const tip = policy
        ? t('events.correlation.chip.flappingHint', { minutes: policy.flapStableMinutes })
        : t('events.correlation.chip.flappingHintNoPolicy')
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <HintedChip tint={FLAP_CHIP} label={t('events.correlation.chip.flapping', { count: event.transitions24h })} hint={tip} />
          {event.incident && <Link to={`/incidents/${event.incident.id}`} onClick={stop} style={linkStyle}>{event.incident.number}</Link>}
        </span>
      )
    }
    case 'storm': {
      const inc = event.incident
      const label = inc ? t('events.correlation.chip.storm', { number: inc.number }) : t('events.correlation.chip.stormUnknown')
      const tip = t('events.correlation.chip.stormHint', { source: event.source?.name ?? '—' })
      return <HintedChip tint={STORM_CHIP} label={label} hint={tip} to={inc ? `/incidents/${inc.id}` : undefined} onLinkClick={stop} />
    }
    case 'storm_no_ci':
      return <HintedChip tint={STORM_CHIP} label={t('events.correlation.chip.storm_no_ci')} hint={t('events.correlation.text.storm_no_ci', { source: event.source?.name ?? '—' })} />
  }

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
      const pill = <Pill bg={TINT_NEUTRAL.bg} color={TINT_NEUTRAL.color} style={chipFont}>{label}</Pill>
      return chg
        ? <Link to={`/changes/${chg.id}`} onClick={stop} title={chg.title} style={{ textDecoration: 'none' }}>{pill}</Link>
        : pill
    }
    case 'delayed': {
      const secs = delayedOpensIn(event, policy)
      const counting = secs !== null && secs > 0
      const tip = counting ? t('events.correlation.chip.delayedIn', { seconds: secs }) : t('events.correlation.chip.delayedWaiting')
      // Il countdown è visibile sotto il chip (aggiornato a ogni polling), non solo nel tooltip.
      const note = counting ? t('events.correlation.chip.delayedInShort', { seconds: secs }) : null
      return <HintedChip tint={TINT_INFO} label={t('events.correlation.chip.delayed')} hint={tip} note={note} />
    }
    case 'pending':
      return <HintedChip tint={TINT_INFO} label={t('events.correlation.chip.pending')} hint={t('events.correlation.text.pending')} />
    case 'skipped_orphan':
      return <HintedChip tint={TINT_WARNING} label={t('events.correlation.chip.linkCI')} hint={t('events.correlation.text.skipped_orphan')} />
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
    case 'pending': return t('events.correlation.text.pending')
    case 'flapping': {
      const vars = { count: ev.transitions24h, since: formatDateTime(ev.flappingSince) }
      return policy
        ? t('events.correlation.text.flapping', { ...vars, minutes: policy.flapStableMinutes })
        : t('events.correlation.text.flappingNoPolicy', vars)
    }
    case 'storm': {
      const source = ev.source?.name ?? '—'
      return ev.incident
        ? t('events.correlation.text.storm', { source, number, when })
        : t('events.correlation.text.stormNoIncident', { source, when })
    }
    case 'storm_no_ci': return t('events.correlation.text.storm_no_ci', { source: ev.source?.name ?? '—' })
    default:     return t('events.correlation.text.unknown', { value: String(ev.correlation) })
  }
}
