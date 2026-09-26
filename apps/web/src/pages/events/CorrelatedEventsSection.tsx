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
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Radar, ArrowRight } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { SimpleTable, type SimpleColumn } from '@/components/ui/SimpleTable'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { ciPath } from '@/lib/ciPath'
import { colors } from '@/lib/tokens'
import { EventStatusBadge, EventSeverityBadge, EventNoCIBadge, resourceKindLabel } from './eventShared'
import type { EventRow } from '@/types/events'

const linkStyle = { color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2, fontWeight: 500 } as const

/**
 * The alarm title never gets narrower than this (D8, tour of 23 Sep 2026): in
 * the incident detail the other columns do not wrap, so the title column was
 * squeezed to ~50px and the title wrapped word by word. Now it wraps at a
 * readable width, and when the section is narrower than the table, the table
 * scrolls inside its own container, key columns first.
 */
const ALARM_TITLE_MIN_WIDTH = 220

/** Tabella compatta degli eventi (condivisa da incident e change): the app's small table, the row opens the alarm. */
function EventRows({ events }: { events: EventRow[] }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const columns: SimpleColumn<EventRow>[] = [
    { key: 'status', label: t('events.columns.status'), render: (_v, ev) => <EventStatusBadge status={ev.status} severity={ev.severity} /> },
    { key: 'severity', label: t('events.columns.severity'), render: (_v, ev) => <EventSeverityBadge severity={ev.severity} /> },
    { key: 'title', label: t('events.columns.title'), minWidth: ALARM_TITLE_MIN_WIDTH, render: (_v, ev) => (
      <>
        <div style={{ fontWeight: 500 }}>{ev.title}</div>
        <div style={{ fontSize: 'var(--font-size-table)', color: colors.slateLight, marginTop: 2 }}>{resourceKindLabel(t, ev.resourceKind)} · {ev.resource}</div>
      </>
    ) },
    // The CI is somewhere else than the row: a real link.
    { key: 'ci', label: t('events.columns.ci'), render: (_v, ev) => ev.ci
      ? <Link to={ciPath(ev.ci)} style={linkStyle}>{ev.ci.name}</Link>
      : <EventNoCIBadge matchReason={ev.matchReason} /> },
    { key: 'source', label: t('events.columns.source'), render: (_v, ev) => <span style={{ color: colors.slate, whiteSpace: 'nowrap' }}>{ev.source?.name ?? '—'}</span> },
    { key: 'count', label: t('events.columns.count'), align: 'right', render: (_v, ev) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{ev.count}</span> },
    { key: 'lastSeenAt', label: t('events.columns.lastSeen'), render: (_v, ev) => <span title={formatDateTime(ev.lastSeenAt)} style={{ color: colors.slateLight, whiteSpace: 'nowrap' }}>{timeAgo(ev.lastSeenAt)}</span> },
  ]
  return <SimpleTable<EventRow> columns={columns} rows={events} onRowClick={(ev) => navigate(`/events/${ev.id}`)} />
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

/**
 * Giro nel browser del 14 set 2026 (#51): un incident aperto a mano da un
 * allarme («Open incident») diceva «aperto automaticamente dal monitoraggio».
 * La storia dell'allarme dice chi l'ha aperto.
 */
function openedManually(ev: EventRow & { history?: ReadonlyArray<{ kind: string; incident?: { id: string } | null }> }, incidentId: string | undefined): boolean {
  return (ev.history ?? []).some((h) => h.kind === 'incident_opened_manually' && (!incidentId || h.incident?.id === incidentId))
}

/**
 * Il conto vero quando la lista e solo una pagina (revisione totale · G-EVT-11).
 *
 * `Incident.correlatedEvents` e `Change.suppressedEvents` sono paginati (100
 * per default), quindi il titolo diceva «Allarmi di monitoraggio (100)» anche
 * per un incident di tempesta con 2.500 allarmi. Il conto nel titolo ora e il
 * totale, e sotto la lista si dice quanti se ne vedono.
 */
function partialNotice(shown: number, total: number | undefined, t: TFunction): React.ReactNode {
  if (total === undefined || total <= shown) return null
  return (
    <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
      {t('events.correlated.partial', { shown, total })}
    </p>
  )
}

/**
 * `purged`: allarmi già eliminati dalla conservazione (Incident.correlatedEventsPurged): la timeline li cita ancora, la lista no.
 * `total`: quanti sono in tutto (G-EVT-11), che puo essere piu di `events.length`.
 */
export function MonitoringAlarmsSection({ events, total, purged = 0, incidentId }: { events: EventRow[]; total?: number; purged?: number; incidentId?: string }) {
  const { t } = useTranslation()
  const opener = openedByMonitoring(events)
  return (
    <SectionCard title={t('pages.incidents.monitoringAlarms.title')} count={total ?? events.length} collapsible defaultOpen={events.length > 0}
      headerRight={incidentId && events.length > 0 ? <ConsoleLink to={`/events?incidentId=${encodeURIComponent(incidentId)}`} /> : undefined}>
      {opener && (
        <p style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateDark }}>
          <Radar size={14} color={colors.brand} aria-hidden="true" />
          {t(openedManually(opener, incidentId) ? 'pages.incidents.monitoringAlarms.openedFromAlarm' : 'pages.incidents.monitoringAlarms.openedByMonitoring', { when: formatDateTime(opener.correlationAt) })}
        </p>
      )}
      {events.length === 0
        ? <p style={emptyStyle}>{t('pages.incidents.monitoringAlarms.empty')}</p>
        : <EventRows events={events} />}
      {partialNotice(events.length, total, t)}
      {purged > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
          {t('pages.incidents.monitoringAlarms.purged', { count: purged })}
        </p>
      )}
    </SectionCard>
  )
}

/** `total`: quanti sono in tutto, la lista e paginata (revisione totale · G-EVT-11). */
export function SuppressedAlarmsSection({ events, total, changeId }: { events: EventRow[]; total?: number; changeId?: string }) {
  const { t } = useTranslation()
  return (
    <SectionCard title={t('pages.changes.suppressedAlarms.title')} count={total ?? events.length} collapsible defaultOpen={events.length > 0}
      headerRight={changeId && events.length > 0 ? <ConsoleLink to={`/events?changeId=${encodeURIComponent(changeId)}`} /> : undefined}>
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate, lineHeight: 1.6 }}>
        {t('pages.changes.suppressedAlarms.note')}
      </p>
      {events.length === 0
        ? <p style={emptyStyle}>{t('pages.changes.suppressedAlarms.empty')}</p>
        : <EventRows events={events} />}
      {partialNotice(events.length, total, t)}
    </SectionCard>
  )
}
