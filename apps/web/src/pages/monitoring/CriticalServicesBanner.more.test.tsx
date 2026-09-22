/**
 * The two edges of the critical-services banner the main suite does not reach:
 *
 * - the query that says WHICH criticalities count can fail. Then nobody knows
 *   whether a critical service is down, and the banner must say so instead of
 *   disappearing (an empty banner reads as «all is well» during an outage);
 * - the server returns a row with no criticality despite the criticality
 *   filter. That is a broken contract: the row is dropped (no «is down ()»
 *   line) and the breakage is reported in the console, not swallowed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { CriticalServicesBanner } from './CriticalServicesBanner'
import { GET_SERVICE_MAPS, GET_CRITICAL_SERVICE_CRITICALITIES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { COUNTS, mapRow, SERVICE } from '@/test/mocks/services'

const criticalities: GqlMock = {
  request: { query: GET_CRITICAL_SERVICE_CRITICALITIES, variables: () => true },
  result: () => ({ data: { criticalServiceCriticalities: ['business_critical'] } }),
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const maps = (items: Record<string, unknown>[]): GqlMock => ({
  request: { query: GET_SERVICE_MAPS, variables: () => true },
  result: () => ({ data: { serviceMaps: { __typename: 'ServiceMapPage', total: items.length, counts: COUNTS, items } } }),
  maxUsageCount: Number.POSITIVE_INFINITY,
})

afterEach(() => { vi.restoreAllMocks() })

describe('CriticalServicesBanner — edges', () => {
  it('the criticalities query fails: a visible alert with the server message, never silence', async () => {
    const failing: GqlMock = { request: { query: GET_CRITICAL_SERVICE_CRITICALITIES, variables: () => true }, error: new Error('matrix unreadable'), maxUsageCount: Number.POSITIVE_INFINITY }
    renderWithProviders(<CriticalServicesBanner />, { mocks: [failing] })
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot tell whether a critical service is down: matrix unreadable')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })

  it('a row without criticality is dropped and reported; the valid rows still show', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = mapRow({ id: 'map-4', name: 'Wiki', health: 'down', impactScore: 100, service: { ...SERVICE, id: 'ba-4', name: 'Wiki', criticality: null } })
    const good = mapRow({ id: 'map-1', name: 'Enterprise Billing', health: 'down', impactScore: 100 })
    renderWithProviders(<CriticalServicesBanner />, { mocks: [criticalities, maps([broken, good])] })
    const banner = await screen.findByTestId('critical-services-banner')
    expect(within(banner).getByRole('link', { name: 'Enterprise Billing' })).toBeInTheDocument()
    expect(within(banner).queryByRole('link', { name: 'Wiki' })).not.toBeInTheDocument()
    // The console line names the filter and the offending row, so the broken contract can be traced.
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/business_critical.*Wiki.*no criticality/))
  })

  it('only rows without criticality: no banner at all (nothing valid to announce)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = mapRow({ id: 'map-4', name: 'Wiki', health: 'down', impactScore: 100, service: { ...SERVICE, id: 'ba-4', name: 'Wiki', criticality: null } })
    renderWithProviders(<CriticalServicesBanner />, { mocks: [criticalities, maps([broken])] })
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })
})
