/**
 * THE MONITORING ALARMS OF AN INCIDENT OR A CHANGE: what the base test does not walk.
 *
 * The list is a PAGE of a longer list (100 by default): the count in the
 * title is the real total, and under the list the section says how many are
 * shown out of how many (G-EVT-11) — «Monitoring alarms (100)» for a storm of
 * 2,500 alarms read as if there were a hundred. The incident's opener is the
 * EARLIEST alarm that opened it, whatever the order of the list. An alarm
 * without a source shows a dash, and alarms removed by retention are counted.
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { formatDateTime } from '@/lib/datetime'
import type { EventRow } from '@/types/events'
import { MonitoringAlarmsSection, SuppressedAlarmsSection } from './CorrelatedEventsSection'

function eventFixture(over: Partial<EventRow> & { id: string }): EventRow {
  return {
    status: 'firing', severity: 'critical', title: `Alert ${over.id}`, resource: 'web-01', resourceKind: 'hostname',
    count: 3, lastSeenAt: '2026-09-09T08:30:00Z', acknowledgedAt: null,
    source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
    ci: { id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: 'down' },
    incident: { id: 'inc1', number: 'INC-0042', title: 'CPU', status: 'new' },
    suppressedBy: null, correlation: 'attached', correlationAt: '2026-09-09T08:05:00Z',
    flappingSince: null, transitions24h: 0, matchReason: null, ...over,
  }
}

describe('MonitoringAlarmsSection', () => {
  it('the opener is the earliest alarm that opened the incident, whatever the order of the list', () => {
    const events = [
      eventFixture({ id: 'e1', correlation: 'opened', correlationAt: '2026-09-09T08:10:00Z' }),
      eventFixture({ id: 'e2', correlation: 'opened', correlationAt: '2026-09-09T08:00:00Z' }),
      eventFixture({ id: 'e3', correlation: 'opened', correlationAt: '2026-09-09T08:20:00Z' }),
    ]
    renderWithProviders(<MonitoringAlarmsSection events={events} incidentId="inc1" />)
    expect(screen.getByText(`Incident opened automatically by monitoring on ${formatDateTime('2026-09-09T08:00:00Z')}.`)).toBeInTheDocument()
  })

  it('a list that is only a page says how many are shown out of the total, and the title counts the total', () => {
    renderWithProviders(<MonitoringAlarmsSection events={[eventFixture({ id: 'e1' }), eventFixture({ id: 'e2' })]} total={2500} incidentId="inc1" />)
    expect(screen.getByRole('button', { name: /Monitoring alarms/ })).toHaveTextContent('2500')
    expect(screen.getByText('Showing the 2 most recent of 2500: open the console to see them all.')).toBeInTheDocument()
  })

  it('a complete list says nothing about pages', () => {
    renderWithProviders(<MonitoringAlarmsSection events={[eventFixture({ id: 'e1' })]} total={1} incidentId="inc1" />)
    expect(screen.queryByText(/most recent of/)).toBeNull()
  })

  it('an alarm without a source shows a dash in its place', () => {
    renderWithProviders(<MonitoringAlarmsSection events={[eventFixture({ id: 'e1', source: null })]} incidentId="inc1" />)
    const row = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')[0]!
    expect(within(row).getAllByRole('cell')[4]).toHaveTextContent('—')
  })

  it('alarms removed by retention are counted, since the timeline still mentions them', () => {
    renderWithProviders(<MonitoringAlarmsSection events={[eventFixture({ id: 'e1' })]} purged={3} incidentId="inc1" />)
    expect(screen.getByText('3 alarms removed by event retention (still mentioned in the timeline).')).toBeInTheDocument()
  })
})

describe('SuppressedAlarmsSection', () => {
  it('a page of the alarms a change suppressed says it is a page, and the title counts the total', () => {
    renderWithProviders(<SuppressedAlarmsSection events={[eventFixture({ id: 'e1' })]} total={40} changeId="chg1" />)
    expect(screen.getByRole('button', { name: /40/ })).toBeInTheDocument()
    expect(screen.getByText('Showing the 1 most recent of 40: open the console to see them all.')).toBeInTheDocument()
  })
})
