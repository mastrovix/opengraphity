import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { MonitoringAlarmsSection, SuppressedAlarmsSection } from './CorrelatedEventsSection'
import { renderWithProviders } from '@/test/utils'
import type { MonitoringEvent } from '@/types/events'

function eventFixture(over: Partial<MonitoringEvent> & { id: string }): MonitoringEvent {
  return {
    fingerprint: `fp-${over.id}`, externalId: null, status: 'firing', severity: 'critical',
    title: `Alert ${over.id}`, description: null, resource: 'web-01', resourceKind: 'host', labels: null,
    count: 3, firstSeenAt: '2026-09-09T08:00:00Z', lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), resolvedAt: null,
    acknowledgedAt: null, acknowledgedBy: null,
    source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
    ci: { id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: 'down' },
    incident: { id: 'inc1', number: 'INC-0042', title: 'CPU', status: 'new' },
    suppressedBy: null, correlation: 'attached', correlationAt: '2026-09-09T08:05:00Z',
    ...over,
  }
}

describe('MonitoringAlarmsSection (dettaglio incident)', () => {
  it('con eventi: aperta, conteggio, riga "aperto dal monitoraggio", colonne e link a evento/CI', () => {
    const events = [
      eventFixture({ id: 'e2', title: 'Disk full', severity: 'warning', ci: null, count: 7, correlation: 'attached', correlationAt: '2026-09-09T08:05:00Z' }),
      eventFixture({ id: 'e1', title: 'CPU high on web-01', correlation: 'opened', correlationAt: '2026-09-09T08:00:00Z' }),
    ]
    renderWithProviders(<MonitoringAlarmsSection events={events} />)
    const toggle = screen.getByRole('button', { name: /Monitoring alarms/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('2')

    // l'attore è il monitoraggio: dedotto dal primo evento con correlation = opened
    expect(screen.getByText(/^Incident opened automatically by monitoring on .+\.$/)).toBeInTheDocument()

    const rows = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('link', { name: 'Disk full' })).toHaveAttribute('href', '/events/e2')
    expect(within(rows[0]!).getByText('orphan')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('7')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Warning')).toBeInTheDocument()
    expect(within(rows[1]!).getByRole('link', { name: 'web-01' })).toHaveAttribute('href', '/ci/server/ci1')
    expect(screen.getByRole('columnheader', { name: 'Last seen' })).toBeInTheDocument()
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
    renderWithProviders(<SuppressedAlarmsSection events={events} />)
    expect(screen.getByRole('button', { name: /Alarms suppressed in this window/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Alarms received during the release window open no incident/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Latency spike' })).toHaveAttribute('href', '/events/s1')
    expect(screen.getByText('Suppressed')).toBeInTheDocument()
  })

  it('vuota: chiusa di default', () => {
    renderWithProviders(<SuppressedAlarmsSection events={[]} />)
    expect(screen.getByRole('button', { name: /Alarms suppressed in this window/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
