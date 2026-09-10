import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { MonitoringAlarmsSection, SuppressedAlarmsSection } from './CorrelatedEventsSection'
import { renderWithProviders } from '@/test/utils'
import type { EventRow } from '@/types/events'

/** Le sezioni leggono la riga leggera (EventRowFields), come incident e change. */
function eventFixture(over: Partial<EventRow> & { id: string }): EventRow {
  return {
    status: 'firing', severity: 'critical',
    title: `Alert ${over.id}`, resource: 'web-01', resourceKind: 'hostname',
    count: 3, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    acknowledgedAt: null,
    source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
    ci: { id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: 'down' },
    incident: { id: 'inc1', number: 'INC-0042', title: 'CPU', status: 'new' },
    suppressedBy: null, correlation: 'attached', correlationAt: '2026-09-09T08:05:00Z',
    flappingSince: null, transitions24h: 0,
    matchReason: null,
    ...over,
  }
}

describe('MonitoringAlarmsSection (dettaglio incident)', () => {
  it('con eventi: aperta, conteggio, riga "aperto dal monitoraggio", colonne e link a evento/CI', () => {
    const events = [
      eventFixture({ id: 'e2', title: 'Disk full', severity: 'warning', ci: null, count: 7, correlation: 'attached', correlationAt: '2026-09-09T08:05:00Z' }),
      eventFixture({ id: 'e1', title: 'CPU high on web-01', correlation: 'opened', correlationAt: '2026-09-09T08:00:00Z' }),
    ]
    renderWithProviders(<MonitoringAlarmsSection events={events} incidentId="inc1" />)
    const toggle = screen.getByRole('button', { name: /Monitoring alarms/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('2')

    // l'attore è il monitoraggio: dedotto dal primo evento con correlation = opened
    expect(screen.getByText(/^Incident opened automatically by monitoring on .+\.$/)).toBeInTheDocument()

    const rows = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('link', { name: 'Disk full' })).toHaveAttribute('href', '/events/e2')
    expect(within(rows[0]!).getByText('No CI')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('7')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Warning')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Prometheus')).toBeInTheDocument()   // colonna Sorgente
    expect(within(rows[1]!).getByRole('link', { name: 'web-01' })).toHaveAttribute('href', '/ci/server/ci1')
    expect(screen.getByRole('columnheader', { name: 'Last seen' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Occurrences' })).toBeInTheDocument()
    // link alla console filtrata per incident
    expect(screen.getByRole('link', { name: /Open in the console/ })).toHaveAttribute('href', '/events?incidentId=inc1')
  })

  it('senza CI e riconoscimento ambiguo: badge "Ambiguous" al posto di "No CI"', () => {
    renderWithProviders(<MonitoringAlarmsSection events={[eventFixture({ id: 'e3', ci: null, matchReason: 'ambiguous' })]} />)
    expect(screen.getByText('Ambiguous')).toBeInTheDocument()
    expect(screen.queryByText('No CI')).not.toBeInTheDocument()
    // senza incidentId nessun link alla console
    expect(screen.queryByRole('link', { name: /Open in the console/ })).not.toBeInTheDocument()
  })

  it('senza "opened": nessuna riga sull\'attore', () => {
    renderWithProviders(<MonitoringAlarmsSection events={[eventFixture({ id: 'e1' })]} />)
    expect(screen.queryByText(/opened automatically by monitoring/)).not.toBeInTheDocument()
  })

  it('vuota: chiusa di default, aperta mostra il testo vuoto', async () => {
    const { user } = renderWithProviders(<MonitoringAlarmsSection events={[]} />)
    const toggle = screen.getByRole('button', { name: /Monitoring alarms/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByText('No monitoring alarm is correlated to this incident.')).toBeInTheDocument()
  })
})

describe('SuppressedAlarmsSection (dettaglio change)', () => {
  it('con eventi: aperta, nota sul silenzio e righe', () => {
    const events = [eventFixture({ id: 's1', title: 'Latency spike', status: 'suppressed', correlation: 'suppressed', incident: null, suppressedBy: { id: 'chg1', code: 'CHG-0007', title: 'Freeze' } })]
    renderWithProviders(<SuppressedAlarmsSection events={events} changeId="chg1" />)
    expect(screen.getByRole('button', { name: /Alarms suppressed in this window/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Alarms received during the release window open no incident/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Latency spike' })).toHaveAttribute('href', '/events/s1')
    expect(screen.getByText('Suppressed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open in the console/ })).toHaveAttribute('href', '/events?changeId=chg1')
  })

  it('vuota: chiusa di default', () => {
    renderWithProviders(<SuppressedAlarmsSection events={[]} />)
    expect(screen.getByRole('button', { name: /Alarms suppressed in this window/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
