/**
 * CI health, the parts the main test does not reach. For an operator on call:
 * - each link inside a row (name, alarms, services, map) must go where it
 *   says, not be swallowed by the row click that opens the CI detail;
 * - a failed first load must show an error with retry, not an empty table;
 * - paging and the type filter live in the URL (shareable, survive F5);
 * - when the search changes from outside (back/forward, a link), the search
 *   box follows the URL instead of writing its stale text back;
 * - a CI whose health has no source shows a dash, not a wrong source.
 */
import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useNavigate } from 'react-router-dom'
import { CIHealthPage } from './CIHealthPage'
import { GET_CI_HEALTH_OVERVIEW, GET_BASE_CI_TYPE, GET_EVENT_POLICY } from '@/graphql/queries'
import { renderWithProviders, type GqlMock, attendiURL } from '@/test/utils'
import { meMock, teamsMock } from '@/test/mocks/gql'
import type { CIHealthOverview, CIHealthRow } from '@/types/events'

function row(over: Partial<CIHealthRow> & { id: string; name: string }): CIHealthRow {
  return {
    type: 'server', environment: 'production', health: 'down', healthSource: 'monitoring',
    healthSince: new Date(Date.now() - 42 * 60_000).toISOString(), lastEventAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    firingEvents: 2, dependents: 7, servicesCount: 2, ownerTeam: 'DBA', supportTeam: null, ...over,
  }
}

const ROWS: CIHealthRow[] = [
  row({ id: 'ci-1', name: 'db-01' }),
  row({ id: 'ci-2', name: 'cache-02', health: 'degraded', healthSource: null }),
]
const OVERVIEW: CIHealthOverview = { down: 1, degraded: 1, operational: 0, unmonitored: 0, downDependents: 7, degradedDependents: 7, total: 120, items: ROWS }

type Vars = { filter: Record<string, unknown> | null; limit: number; offset: number }

function overviewMock(seen?: Vars[]): GqlMock {
  return {
    request: { query: GET_CI_HEALTH_OVERVIEW, variables: (v) => { seen?.push(v as Vars); return true } },
    result: { data: { ciHealthOverview: { __typename: 'CIHealthOverview', ...OVERVIEW, items: OVERVIEW.items.map((r) => ({ __typename: 'CIHealthRow', ...r })) } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}
const overviewErrorMock = (): GqlMock => ({ request: { query: GET_CI_HEALTH_OVERVIEW, variables: () => true }, error: new Error('overview down'), maxUsageCount: Number.POSITIVE_INFINITY })
const baseTypeErrorMock = (): GqlMock => ({ request: { query: GET_BASE_CI_TYPE }, error: new Error('metamodel down'), maxUsageCount: Number.POSITIVE_INFINITY })
const policyMock = (): GqlMock => ({
  request: { query: GET_EVENT_POLICY },
  result: { data: { eventPolicy: { __typename: 'EventPolicy', highImpactDependents: 5 } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

/** Stands for the browser's back/forward or an external link changing the search in the URL. */
function ExternalNav() {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate('/monitoring/health?q=from-link')}>external</button>
}

function renderPage(opts: { route?: string; overview?: GqlMock; seen?: Vars[]; withNav?: boolean } = {}) {
  return renderWithProviders(<>{opts.withNav && <ExternalNav />}<CIHealthPage /></>, {
    route: opts.route ?? '/monitoring/health',
    mocks: [meMock('operator'), opts.overview ?? overviewMock(opts.seen), teamsMock([{ id: 't1', name: 'DBA' }]), baseTypeErrorMock(), policyMock()],
  })
}

const firstRow = async () => {
  await screen.findByText('db-01')
  return within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')[0]!
}

describe('CIHealthPage — links inside a row win over the row click', () => {
  it('the row opens the CI detail', async () => {
    renderPage()
    await userEvent.click(within(await firstRow()).getByText('db-01'))
    await attendiURL('/ci/server/ci-1')
  })

  it('the alarm count opens the events of that CI', async () => {
    renderPage()
    await userEvent.click(within(await firstRow()).getByRole('link', { name: 'View the 2 active alarms of db-01' }))
    await attendiURL('/events', { ciId: 'ci-1' })
  })

  it('the services count opens the services filtered on that CI', async () => {
    renderPage()
    await userEvent.click(within(await firstRow()).getByRole('link', { name: '2 monitored services depend on db-01' }))
    await attendiURL('/monitoring/services', { ciId: 'ci-1' })
  })

  it('the map icon opens the topology centred on that CI', async () => {
    renderPage()
    await userEvent.click(within(await firstRow()).getByRole('link', { name: 'View db-01 on the map' }))
    await attendiURL('/topology', { health: '1', ciId: 'ci-1' })
  })

  it('a health with no source shows a dash in the source column', async () => {
    renderPage()
    await screen.findByText('cache-02')
    const second = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')[1]!
    const cells = within(second).getAllByRole('cell')
    // Source is the 8th column.
    expect(cells[7]).toHaveTextContent('—')
  })
})

describe('CIHealthPage — failures and URL state', () => {
  it('a failed first load shows the error with a retry that queries again', async () => {
    const seen: Vars[] = []
    renderPage({ overview: { ...overviewErrorMock(), request: { query: GET_CI_HEALTH_OVERVIEW, variables: (v) => { seen.push(v as Vars); return true } } } })
    expect(await screen.findByText('overview down')).toBeInTheDocument()
    // The base enums failure is visible next to the filters, not only in the console.
    expect(screen.getByText(/Environments unavailable/)).toBeInTheDocument()
    const before = seen.length
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(seen.length).toBeGreaterThan(before))
  })

  it('refresh queries again', async () => {
    const seen: Vars[] = []
    renderPage({ seen })
    await screen.findByText('db-01')
    const before = seen.length
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(seen.length).toBeGreaterThan(before))
  })

  it('paging writes the page in the URL (1-based) and queries the matching offset', async () => {
    const seen: Vars[] = []
    renderPage({ seen })
    await screen.findByText('db-01')
    expect(screen.getByText('page 1 of 3')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next →' }))
    await attendiURL('/monitoring/health', { page: '2' })
    await waitFor(() => expect(seen.at(-1)?.offset).toBe(50))
    await userEvent.click(screen.getByRole('button', { name: '← Prev' }))
    // Page one is the default: it is removed from the URL, not written as page=1.
    await attendiURL('/monitoring/health')
  })

  it('the type filter goes in the URL and restarts from the first page', async () => {
    renderPage({ route: '/monitoring/health?page=2' })
    await screen.findByText('db-01')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'CI type' }), 'server')
    await attendiURL('/monitoring/health', { type: 'server' })
  })

  it('when the search changes from outside, the search box follows the URL', async () => {
    renderPage({ route: '/monitoring/health?q=db', withNav: true })
    const box = screen.getByRole('textbox', { name: 'Search a CI by name' })
    expect(box).toHaveValue('db')
    await userEvent.click(screen.getByRole('button', { name: 'external' }))
    await waitFor(() => expect(box).toHaveValue('from-link'))
    // And the box does not write its old text back after the debounce.
    await attendiURL('/monitoring/health', { q: 'from-link' })
  })
})
