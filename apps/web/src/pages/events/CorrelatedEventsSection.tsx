/**
 * Liste di allarmi di monitoraggio dentro i ticket (Event Management, ondata 3):
 * - `MonitoringAlarmsSection`: gli eventi correlati a un incident
 *   (`Incident.correlatedEvents`), con la riga "aperto dal monitoraggio" se
 *   è stata la policy ad aprirlo;
 * - `SuppressedAlarmsSection`: gli eventi silenziati dalla finestra di
 *   rilascio di una change (`Change.suppressedEvents`), con la nota su cosa
 *   significa il silenzio.
 *
 * Stessa tabella per entrambe: stato, severità, allarme (link al dettaglio),
 * CI, sorgente, ricorrenze, ultimo visto. Chiuse di default se vuote, aperte
 * se piene. Con l'id del ticket la sezione offre "Apri nella console" →
 * `/events?incidentId=` / `/events?changeId=` (filtri `incidentId` e
 * `suppressedByChangeId` di EventFilter), dove ci sono azioni e paginazione.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Radar, ArrowRight } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { colors } from '@/lib/tokens'
import { EventStatusBadge, EventSeverityBadge, EventNoCIBadge, resourceKindLabel } from './eventShared'
import type { EventRow } from '@/types/events'

const th = { textAlign: 'left', padding: '4px 8px', color: colors.slateLight, fontWeight: 500, fontSize: 'var(--font-size-label)', textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' } as const
const td = { padding: '6px 8px', borderBottom: '1px solid var(--color-border-light)', verticalAlign: 'middle' } as const
const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const

/** Tabella compatta degli eventi (condivisa da incident e change). */
function EventRows({ events }: { events: EventRow[] }) {
  const { t } = useTranslation()
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
        <thead>
          <tr>
            <th scope="col" style={th}>{t('events.columns.status')}</th>
            <th scope="col" style={th}>{t('events.columns.severity')}</th>
            <th scope="col" style={th}>{t('events.columns.title')}</th>
            <th scope="col" style={th}>{t('events.columns.ci')}</th>
            <th scope="col" style={th}>{t('events.columns.source')}</th>
            <th scope="col" style={{ ...th, textAlign: 'right' }}>{t('events.columns.count')}</th>
            <th scope="col" style={th}>{t('events.columns.lastSeen')}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => (
            <tr key={ev.id}>
              <td style={td}><EventStatusBadge status={ev.status} severity={ev.severity} /></td>
              <td style={td}><EventSeverityBadge severity={ev.severity} /></td>
              <td style={td}>
                <Link to={`/events/${ev.id}`} style={linkStyle}>{ev.title}</Link>
                <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 2 }}>{resourceKindLabel(t, ev.resourceKind)} · {ev.resource}</div>
              </td>
              <td style={td}>
                {ev.ci
                  ? <Link to={ciPath(ev.ci)} style={linkStyle}>{ev.ci.name}</Link>
                  : <EventNoCIBadge matchReason={ev.matchReason} />}
              </td>
              <td style={{ ...td, color: colors.slate, whiteSpace: 'nowrap' }}>{ev.source?.name ?? '—'}</td>
              <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{ev.count}</td>
              <td style={{ ...td, color: colors.slateLight, whiteSpace: 'nowrap' }} title={formatDateTime(ev.lastSeenAt)}>{timeAgo(ev.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const emptyStyle = { fontSize: 'var(--font-size-body)', color: colors.slateLight, margin: 0 } as const

/** Link interno alla console filtrata (icona freccia: non è una nuova finestra). */
function ConsoleLink({ to }: { to: string }) {
  const { t } = useTranslation()
  return (
    <Link to={to} style={{ ...linkStyle, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-table)' }}>
      {t('events.openInConsole')} <ArrowRight size={12} aria-hidden="true" />
    </Link>
  )
}

/**
 * Primo evento che ha aperto l'incident: è la prova che l'attore è il
 * monitoraggio (l'API non espone un "creatore" dell'incident).
 */
function openedByMonitoring(events: EventRow[]): EventRow | null {
  const opened = events.filter((e) => e.correlation === 'opened' && e.correlationAt)
  if (opened.length === 0) return null
  return opened.reduce((first, e) => (e.correlationAt! < first.correlationAt! ? e : first))
}

/** `purged`: allarmi già eliminati dalla conservazione (Incident.correlatedEventsPurged): la timeline li cita ancora, la lista no. */
export function MonitoringAlarmsSection({ events, purged = 0, incidentId }: { events: EventRow[]; purged?: number; incidentId?: string }) {
  const { t } = useTranslation()
  const opener = openedByMonitoring(events)
  return (
    <SectionCard title={t('pages.incidents.monitoringAlarms.title')} count={events.length} collapsible defaultOpen={events.length > 0}
      headerRight={incidentId && events.length > 0 ? <ConsoleLink to={`/events?incidentId=${encodeURIComponent(incidentId)}`} /> : undefined}>
      {opener && (
        <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
          <Radar size={14} color={colors.brand} aria-hidden="true" />
          {t('pages.incidents.monitoringAlarms.openedByMonitoring', { when: formatDateTime(opener.correlationAt) })}
        </p>
      )}
      {events.length === 0
        ? <p style={emptyStyle}>{t('pages.incidents.monitoringAlarms.empty')}</p>
        : <EventRows events={events} />}
      {purged > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
          {t('pages.incidents.monitoringAlarms.purged', { count: purged })}
        </p>
      )}
    </SectionCard>
  )
}

export function SuppressedAlarmsSection({ events, changeId }: { events: EventRow[]; changeId?: string }) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t('pages.changes.suppressedAlarms.title')} count={events.length} collapsible defaultOpen={events.length > 0}
      headerRight={changeId && events.length > 0 ? <ConsoleLink to={`/events?changeId=${encodeURIComponent(changeId)}`} /> : undefined}>
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate, lineHeight: 1.6 }}>
        {t('pages.changes.suppressedAlarms.note')}
      </p>
      {events.length === 0
        ? <p style={emptyStyle}>{t('pages.changes.suppressedAlarms.empty')}</p>
        : <EventRows events={events} />}
    </SectionCard>
  )
}
