/**
 * The CMDB list is where every CI investigation starts. What must hold for a
 * user: picking a type narrows the list through the URL (the only filter on
 * type that works, since the type is a graph label); sorting and filtering
 * restart from page one (otherwise a filter that returns 10 rows shows an
 * empty page 3); paging moves the offset; a click opens the CI; and a failed
 * query shows an error with retry instead of "no CIs", which a user would
 * read as "the filter found nothing".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const baseEnums = vi.hoisted(() => ({ value: { statuses: ['active'], environments: ['production'], loading: false, error: null as string | null } }))
vi.mock('@/lib/ciEnums', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ciEnums')>()),
  useCIBaseEnums: () => baseEnums.value,
}))

import { CMDBPage } from './CMDBPage'

const ITEMS = [
  { id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'production', createdAt: '2026-09-01T00:00:00Z', health: null },
  { id: 'ci-2', name: 'web-02', type: 'database', status: 'active', environment: 'production', createdAt: '2026-09-01T00:00:00Z', health: 'down' },
]

const lastVars = () => apolloFinto.chiamata('GetAllCIs') as Record<string, unknown>

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { total: 120, items: ITEMS } }
  baseEnums.value = { statuses: ['active'], environments: ['production'], loading: false, error: null }
})

describe('CMDBPage — type from the URL', () => {
  it('titles the page with the type label and offers creation of that type', async () => {
    renderWithProviders(<CMDBPage />, { route: '/cmdb?type=server', path: '/cmdb' })
    expect(screen.getByRole('heading', { name: 'Server' })).toBeInTheDocument()
    expect(lastVars()).toMatchObject({ type: 'server', offset: 0, limit: 50 })
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await attendiURL('/ci/server')
  })

  it('without a type there is no create button (it would have nowhere to go)', () => {
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb' })
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
    expect(screen.getByText('120 CIs')).toBeInTheDocument()
  })

  it('choosing a type writes it in the URL, "all types" removes it', async () => {
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb' })
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'database')
    await attendiURL('/cmdb', { type: 'database' })
    await userEvent.selectOptions(screen.getByLabelText('Type'), '')
    await attendiURL('/cmdb')
  })
})

describe('CMDBPage — list interactions', () => {
  it('pages forward and back by 50', async () => {
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb' })
    await userEvent.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastVars()).toMatchObject({ offset: 50 })
    await userEvent.click(screen.getByRole('button', { name: '← Prev' }))
    expect(lastVars()).toMatchObject({ offset: 0 })
  })

  it('sorting is done by the server and restarts from the first page', async () => {
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb' })
    await userEvent.click(screen.getByRole('button', { name: 'Next →' }))
    const table = screen.getByRole('table')
    await userEvent.click(within(table).getByText('Name'))
    expect(lastVars()).toMatchObject({ sortField: 'name', sortDirection: 'asc', offset: 0 })
  })

  it('a row opens the CI in its own type page', async () => {
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb' })
    await userEvent.click(screen.getByText('web-02'))
    await attendiURL('/ci/database/ci-2')
  })

  it('applying the advanced filter sends it and restarts from page one; reset removes it', async () => {
    renderWithProviders(<CMDBPage />, { route: '/cmdb?health=down', path: '/cmdb' })
    await userEvent.click(screen.getByRole('button', { name: 'Next →' }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(lastVars()).toMatchObject({ offset: 0 }))
    expect(JSON.parse(String(lastVars()['filters']))).toEqual({ rules: [expect.objectContaining({ field: 'health', operator: 'equals', value: 'down' })] })
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(lastVars()['filters']).toBeNull())
  })
})

describe('CMDBPage — errors are visible', () => {
  it('a failed query shows the error with a retry, not an empty CMDB', async () => {
    apolloFinto.erroriQuery['GetAllCIs'] = new Error('Invalid filter')
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb' })
    expect(screen.getByText('Invalid filter')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /retry|try again/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('says when the status/environment values cannot be read from the metamodel', () => {
    baseEnums.value = { statuses: [], environments: [], loading: false, error: 'boom' }
    renderWithProviders(<CMDBPage />, { route: '/cmdb', path: '/cmdb' })
    expect(screen.getByText(/Status\/environment values unavailable.*: boom/)).toBeInTheDocument()
  })
})
