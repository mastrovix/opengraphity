/**
 * Liste di allarmi di monitoraggio dentro i ticket (Event Management, ondata 3):
 * - `MonitoringAlarmsSection`: gli eventi correlati a un incident
 *   (`Incident.correlatedEvents`), con la riga "aperto dal monitoraggio" se
 *   è stata la policy ad aprirlo;
 * - `SuppressedAlarmsSection`: gli eventi silenziati dalla finestra di
 *   rilascio di una change (`Change.suppressedEvents`), con la nota su cosa
 *   significa il silenzio.
 *
 * Stessa tabella per entrambe: stato, severità, evento (link al dettaglio),
 * CI, ricorrenze, ultimo visto. Chiuse di default se vuote, aperte se piene.
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Radar } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { colors } from '@/lib/tokens'
import { EventStatusBadge, EventSeverityBadge } from './eventShared'
import type { MonitoringEvent } from '@/types/events'

const th = { textAlign: 'left', padding: '4px 8px', color: colors.slateLight, fontWeight: 500, fontSize: 'var(--font-size-label)', textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' } as const
const td = { padding: '6px 8px', borderBottom: '1px solid #f1f3f9', verticalAlign: 'middle' } as const
const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const

/** Tabella compatta degli eventi (condivisa da incident e change). */
function EventRows({ events }: { events: MonitoringEvent[] }) {
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
                <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 2 }}>{ev.resourceKind} · {ev.resource}</div>
              </td>
              <td style={td}>
                {ev.ci
                  ? <Link to={ciPath(ev.ci)} style={linkStyle}>{ev.ci.name}</Link>
                  : <span style={{ color: colors.slateLight }}>{t('events.orphan')}</span>}
              </td>
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

/**
 * Primo evento che ha aperto l'incident: è la prova che l'attore è il
 * monitoraggio (l'API non espone un "creatore" dell'incident).
 */
function openedByMonitoring(events: MonitoringEvent[]): MonitoringEvent | null {
  const opened = events.filter((e) => e.correlation === 'opened' && e.correlationAt)
  if (opened.length === 0) return null
  return opened.reduce((first, e) => (e.correlationAt! < first.correlationAt! ? e : first))
}

export function MonitoringAlarmsSection({ events }: { events: MonitoringEvent[] }) {
  const { t } = useTranslation()
  const opener = openedByMonitoring(events)
  return (
    <SectionCard title={t('pages.incidents.monitoringAlarms.title')} count={events.length} collapsible defaultOpen={events.length > 0}>
      {opener && (
        <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
          <Radar size={14} color={colors.brand} aria-hidden="true" />
          {t('pages.incidents.monitoringAlarms.openedByMonitoring', { when: formatDateTime(opener.correlationAt) })}
        </p>
      )}
      {events.length === 0
        ? <p style={emptyStyle}>{t('pages.incidents.monitoringAlarms.empty')}</p>
        : <EventRows events={events} />}
    </SectionCard>
  )
}

export function SuppressedAlarmsSection({ events }: { events: MonitoringEvent[] }) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t('pages.changes.suppressedAlarms.title')} count={events.length} collapsible defaultOpen={events.length > 0}>
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate, lineHeight: 1.6 }}>
        {t('pages.changes.suppressedAlarms.note')}
      </p>
      {events.length === 0
        ? <p style={emptyStyle}>{t('pages.changes.suppressedAlarms.empty')}</p>
        : <EventRows events={events} />}
    </SectionCard>
  )
}
