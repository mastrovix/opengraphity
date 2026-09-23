/**
 * THE BODY OF A WIDGET WHOSE DATA SOURCE IS FIXED (active alarms, service health).
 *
 * The real dashboard card and the preview of the configuration panel both
 * draw it from here, so that what a user configures is what the dashboard
 * shows. The type chooses the body. A type declared "data-free" but without a
 * body must be a visible error naming the type: an empty box on a monitoring
 * dashboard reads as "nothing is wrong".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { meFixture } from '@/test/mocks/gql'
import { DataFreeWidgetBody } from './DataFreeWidgetBody'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMe'] = { me: meFixture('operator') }
  apolloFinto.risposte['GetEventStats'] = { eventStats: {
    firing: 5, critical: 2, warning: 3, orphan: 1, suppressed: 0, flapping: 0, resolved24h: 9, stormSources: [],
  } }
  apolloFinto.risposte['GetServiceHealthCounts'] = { serviceMaps: { counts: {
    total: 9, operational: 5, degraded: 2, down: 1, maintenance: 1, unknown: 0,
  } } }
})

describe('DataFreeWidgetBody', () => {
  it('a data-free type without a body is an alert that names the type', () => {
    renderWithProviders(<DataFreeWidgetBody widgetType="disk_usage" color="#0ea5e9" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown data-free widget type: disk_usage')
  })

  it('"active_alarms" draws the counters of the alarm console', () => {
    renderWithProviders(<DataFreeWidgetBody widgetType="active_alarms" color="#0ea5e9" />)
    expect(screen.getByRole('link', { name: 'Critical 2' })).toHaveAttribute('href', '/events?stat=critical')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('"service_health" draws the counters of the monitored services', () => {
    renderWithProviders(<DataFreeWidgetBody widgetType="service_health" color="#0ea5e9" large />)
    expect(screen.getByRole('link', { name: 'Down 1' })).toHaveAttribute('href', '/monitoring/services?health=down')
    expect(screen.queryByRole('link', { name: /Critical/ })).toBeNull()
  })
})
