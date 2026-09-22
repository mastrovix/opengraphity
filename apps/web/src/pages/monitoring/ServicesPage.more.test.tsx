/**
 * Services page: the row as a whole opens the service, paging, and "Refresh".
 *
 * Why these behaviours matter to an operator: clicking anywhere on a service
 * row must open that service (the name link is only the keyboard target);
 * with more than one page of services, Next/Prev must move the query offset
 * AND the URL, so a shared link lands on the same page; and "Refresh" must
 * really ask the server again, or a status board shows stale health.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { ServicesPage } from './ServicesPage'
import { GET_SERVICE_MAPS, GET_BUSINESS_CAPABILITIES_HEALTH } from '@/graphql/queries'
import { renderWithProviders, type GqlMock, attendiURL } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { mapRow } from '@/test/mocks/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const COUNTS = { __typename: 'ServiceMapCounts', total: 60, operational: 59, degraded: 1, down: 0, maintenance: 0, unknown: 0 }
type Vars = { filter: Record<string, unknown> | null; limit: number; offset: number }

function pageMock(seen: Vars[], total = 1): GqlMock {
  return {
    request: { query: GET_SERVICE_MAPS, variables: (v) => { seen.push(v as Vars); return true } },
    result: { data: { serviceMaps: { __typename: 'ServiceMapPage', total, counts: COUNTS, items: [mapRow()] } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

const capabilitiesMock: GqlMock = {
  request: { query: GET_BUSINESS_CAPABILITIES_HEALTH },
  result: { data: { businessCapabilitiesHealth: [] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

function renderPage(seen: Vars[], opts: { total?: number; route?: string } = {}) {
  return renderWithProviders(<ServicesPage />, {
    route: opts.route ?? '/monitoring/services',
    mocks: [meMock('operator', { maxUsageCount: Number.POSITIVE_INFINITY }), pageMock(seen, opts.total), capabilitiesMock],
  })
}

describe('ServicesPage — row, paging, refresh', () => {
  it('a click anywhere on the row opens the service', async () => {
    const { user } = renderPage([])
    const link = await screen.findByRole('link', { name: 'Enterprise Billing' })
    const row = link.closest('tr')!
    // Click a cell that is not the link: the whole row is the target for the mouse.
    await user.click(within(row).getAllByRole('cell')[1]!)
    await attendiURL('/monitoring/services/map-1')
  })

  it('the name link, the keyboard target, opens the service too', async () => {
    const { user } = renderPage([])
    await user.click(await screen.findByRole('link', { name: 'Enterprise Billing' }))
    await attendiURL('/monitoring/services/map-1')
  })

  it('Next and Prev move the offset and keep the page in the URL', async () => {
    const seen: Vars[] = []
    const { user } = renderPage(seen, { total: 60 })
    await screen.findByRole('link', { name: 'Enterprise Billing' })
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await attendiURL('/monitoring/services', { page: '2' })
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ offset: 50, limit: 50 }))

    await user.click(await screen.findByRole('button', { name: '← Prev' }))
    // Page 1 is the default: it leaves the URL clean instead of writing page=1.
    await attendiURL('/monitoring/services')
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ offset: 0 }))
  })

  it('"Refresh" asks the server again', async () => {
    const seen: Vars[] = []
    const { user } = renderPage(seen)
    await screen.findByRole('link', { name: 'Enterprise Billing' })
    const before = seen.length
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(seen.length).toBeGreaterThan(before))
  })
})
