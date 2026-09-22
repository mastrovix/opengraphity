/**
 * The remaining interactions of the CI "Health" card: the user can fold the
 * card open or shut regardless of the health (the default follows the query
 * only until the user acts), and "Refresh" on the recent alarms really asks
 * the server again — a stale list would hide an alarm that just fired. Each
 * query's error has its own Retry, and Retry must actually recover the data.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { CIHealthSection } from './CIHealthSection'
import { GET_CI_HEALTH, GET_CI_ALIASES, GET_EVENTS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const CI_REF = { __typename: 'ConfigurationItemRef', id: 'srv-1', name: 'web-01', type: 'server', status: 'active', health: 'down' }
const inf = Number.POSITIVE_INFINITY

const healthMock: GqlMock = {
  request: { query: GET_CI_HEALTH, variables: { ciId: 'srv-1' } },
  result: { data: { ciHealth: { __typename: 'CIHealthInfo', ciId: 'srv-1', health: 'down', healthSource: 'monitoring', lastEventAt: '2026-09-09T10:00:00Z', firingEvents: 2 } } },
  maxUsageCount: inf,
}
const aliasesMock: GqlMock = { request: { query: GET_CI_ALIASES, variables: { ciId: 'srv-1' } }, result: { data: { ciAliases: [] } }, maxUsageCount: inf }

const event = (id: string, title: string) => ({
  __typename: 'Event', id, status: 'firing', severity: 'critical', title, resource: 'web-01', resourceKind: 'hostname',
  count: 1, lastSeenAt: '2026-09-09T10:00:00Z', acknowledgedAt: null,
  source: { __typename: 'MonitoringSourceRef', id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
  ci: CI_REF, incident: null, suppressedBy: null, correlation: 'opened', correlationAt: '2026-09-09T10:00:00Z',
  flappingSince: null, transitions24h: 0, matchReason: 'name',
})
const eventsMock = (items: ReturnType<typeof event>[]): GqlMock => ({
  request: { query: GET_EVENTS, variables: { filter: { ciId: 'srv-1' }, limit: 5, offset: 0 } },
  result: { data: { events: { __typename: 'EventPage', total: items.length, items } } },
})

const card = () => screen.getByRole('button', { name: /^Health/ })

describe('CIHealthSection — card toggle and refresh', () => {
  it('the user can fold an open card and open it again', async () => {
    const { user } = renderWithProviders(<CIHealthSection ciId="srv-1" ciName="web-01" />, {
      mocks: [meMock('viewer', { maxUsageCount: inf }), healthMock, aliasesMock, { ...eventsMock([]), maxUsageCount: inf }],
    })
    await waitFor(() => expect(card()).toHaveAttribute('aria-expanded', 'true'))
    await user.click(card())
    expect(card()).toHaveAttribute('aria-expanded', 'false')
    await user.click(card())
    expect(card()).toHaveAttribute('aria-expanded', 'true')
  })

  it('Refresh reloads the recent alarms from the server', async () => {
    const { user } = renderWithProviders(<CIHealthSection ciId="srv-1" ciName="web-01" />, {
      mocks: [meMock('viewer', { maxUsageCount: inf }), healthMock, aliasesMock,
        eventsMock([event('e1', 'CPU high')]),
        eventsMock([event('e1', 'CPU high'), event('e2', 'Disk full')])],
    })
    expect(await screen.findByRole('link', { name: 'CPU high' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Disk full' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    // The second response only arrives through a new network request.
    expect(await screen.findByRole('link', { name: 'Disk full' })).toBeInTheDocument()
  })

  it('a health load error offers Retry, which recovers the health', async () => {
    const { user } = renderWithProviders(<CIHealthSection ciId="srv-1" ciName="web-01" />, {
      mocks: [meMock('viewer', { maxUsageCount: inf }),
        { request: { query: GET_CI_HEALTH, variables: { ciId: 'srv-1' } }, error: new Error('health down') },
        healthMock, aliasesMock, { ...eventsMock([]), maxUsageCount: inf }],
    })
    // The card is closed while health is unknown: open it to reach the error.
    await waitFor(() => expect(card()).toHaveAttribute('aria-expanded', 'false'))
    await user.click(card())
    expect(await screen.findByText('health down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByText('Monitoring')).toBeInTheDocument()
    expect(screen.queryByText('health down')).not.toBeInTheDocument()
  })

  it('a recent-alarms load error offers Retry, which recovers the list', async () => {
    const { user } = renderWithProviders(<CIHealthSection ciId="srv-1" ciName="web-01" />, {
      mocks: [meMock('viewer', { maxUsageCount: inf }), healthMock, aliasesMock,
        { request: { query: GET_EVENTS, variables: { filter: { ciId: 'srv-1' }, limit: 5, offset: 0 } }, error: new Error('events down') },
        eventsMock([event('e1', 'CPU high')])],
    })
    expect(await screen.findByText('events down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByRole('link', { name: 'CPU high' })).toBeInTheDocument()
  })
})
