/**
 * THE INCIDENT LIST: FINDING THE INCIDENTS, AND ACTING ON MANY AT ONCE.
 *
 * The service desk lives on this list during an outage. What it must get
 * right:
 *  - the count, the columns (the tenant's own custom fields included) and
 *    the labels the tenant chose; a row opens its incident;
 *  - sorting, filtering and paging ask the SERVER (the list is paginated) and
 *    start again from the first page, dropping a selection that would no
 *    longer be visible;
 *  - the CSV holds every filtered row, not only the page on screen;
 *  - bulk actions reach every selected incident, say how many succeeded and
 *    how many failed, and cannot be dismissed half-way.
 *
 * The filter builder is replaced by a stand-in that hands the page a filter
 * (it has its own tests); the table, the bulk bar and the dialogs are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { answerEach, hold, inFlight, release, resetInFlight } from '@/test/apolloInFlight'
import { formatDate } from '@/lib/datetime'
import { GET_INCIDENTS } from '@/graphql/queries'
import { IncidentListPage } from './IncidentListPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
const csv = vi.hoisted(() => ({ exportToCsv: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/csvExport', () => ({ exportToCsv: csv.exportToCsv }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { query: csv.query } }))
vi.mock('@/hooks/useEntityFields', () => ({ useEntityFields: () => ({ fields: [], error: null }) }))
const FILTER = { logic: 'and', rules: [{ field: 'status', operator: 'eq', value: 'new' }] }
vi.mock('@/components/FilterBuilder', () => ({
  FilterBuilder: ({ onApply }: { onApply: (g: unknown) => void }) => (
    <div>
      <button type="button" onClick={() => onApply(FILTER)}>apply status filter</button>
      <button type="button" onClick={() => onApply(null)}>clear filters</button>
    </div>
  ),
}))

const incident = (n: number, over: Record<string, unknown> = {}) => ({
  id: `inc-${n}`, number: `INC0000000${n}`, title: `Outage ${n}`, severity: 'high', status: 'new',
  createdAt: '2026-09-20T08:00:00Z', slaStatus: null, customFields: [{ name: 'site', value: `Site ${n}` }], ...over,
})
const page = (items: unknown[], total = items.length) => ({ incidents: { items, total } })

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  toast.success.mockReset()
  toast.error.mockReset()
  toast.warning.mockReset()
  csv.exportToCsv.mockReset()
  csv.query.mockReset()
  apolloFinto.risposte['GetIncidents'] = page([incident(1), incident(2, { severity: 'low', status: 'in_progress' }), incident(3)])
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 't-net', name: 'SUP_Network' }, { id: 't-mail', name: 'SUP_Mail' }] }
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { transitions: [], steps: [
    { id: 's1', name: 'new', label: 'Just opened', labels: [], type: 'state', isInitial: true, isTerminal: false, isOpen: true, category: 'active', purpose: null, order: 0 },
    { id: 's2', name: 'in_progress', label: 'Being worked', labels: [], type: 'state', isInitial: false, isTerminal: false, isOpen: true, category: 'active', purpose: null, order: 1 },
  ] } }
  apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [] }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ id: 'it-inc', name: 'incident', label: 'Incident', fields: [
    { id: 'f-site', name: 'site', label: 'Site', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false, enumTypeName: null, visibleToEndUser: false },
    { id: 'f-title', name: 'title', label: 'Title', fieldType: 'string', required: true, enumValues: [], order: 0, isSystem: true, enumTypeName: null, visibleToEndUser: true },
  ] }] }
})

const mount = () => renderWithProviders(<IncidentListPage />, { route: '/incidents' })
const lastQuery = () => apolloFinto.chiamata('GetIncidents')
const rowOf = (title: string) => screen.getByText(title).closest('tr') as HTMLElement
const checkboxOf = (title: string) => within(rowOf(title)).getByRole('checkbox', { name: 'Select row' })
const toolbar = () => screen.getByRole('toolbar')

describe('IncidentListPage: what the list shows', () => {
  it('the count, the columns with the tenant\'s own fields, and each row as the tenant names it', () => {
    mount()
    expect(screen.getByText('3 incidents')).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Number', 'Title', 'Priority', 'Status', 'SLA', 'Created', 'Site'])
    const second = rowOf('Outage 2')
    expect(within(second).getByText('INC00000002')).toBeInTheDocument()
    // The priority is read with the PRIORITY vocabulary; the status is the step's label.
    expect(within(second).getByTitle('low')).toHaveTextContent('Low')
    expect(within(second).getByText('Being worked')).toBeInTheDocument()
    expect(within(second).getByText(formatDate('2026-09-20T08:00:00Z'))).toBeInTheDocument()
    expect(within(second).getByText('Site 2')).toBeInTheDocument()
    expect(lastQuery()).toEqual({ limit: 50, offset: 0, filters: null, sortField: null, sortDirection: 'desc' })
  })

  it('a row opens its incident', async () => {
    const { user } = mount()
    await user.click(screen.getByText('Outage 3'))
    await attendiURL('/incidents/inc-3')
  })

  it('"New Incident" opens the creation form', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New Incident' }))
    await attendiURL('/incidents/new')
  })

  it('while the list loads the count waits, not "0 incidents"', () => {
    inFlight.add('GetIncidents')
    mount()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/0 incidents/)).not.toBeInTheDocument()
  })

  it('no incident: the empty state says what to do', () => {
    apolloFinto.risposte['GetIncidents'] = page([])
    mount()
    expect(screen.getByText('0 incidents')).toBeInTheDocument()
    expect(screen.getByText('No incidents found')).toBeInTheDocument()
    expect(screen.getByText('Open a new incident or adjust the applied filters.')).toBeInTheDocument()
  })

  it('a failed load shows the error with a retry, not an empty list', async () => {
    apolloFinto.erroriQuery['GetIncidents'] = new Error('incidents unavailable')
    const { user } = mount()
    expect(screen.getByText('incidents unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('coming back from a creation reads the list again', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/incidents', state: { refresh: true } }]}>
        <IncidentListPage />
      </MemoryRouter>,
    )
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('arriving normally does not read it twice', () => {
    mount()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })
})

describe('IncidentListPage: sorting, filtering, paging', () => {
  it('sorting asks the server, and a second click reverses it', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Title' }))
    expect(lastQuery()).toMatchObject({ sortField: 'title', sortDirection: 'asc', offset: 0 })
    await user.click(screen.getByRole('button', { name: 'Title' }))
    expect(lastQuery()).toMatchObject({ sortField: 'title', sortDirection: 'desc' })
  })

  it('a filter travels as JSON and clearing it asks for everything again', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'apply status filter' }))
    expect(lastQuery()).toMatchObject({ filters: JSON.stringify(FILTER), offset: 0 })
    await user.click(screen.getByRole('button', { name: 'clear filters' }))
    expect(lastQuery()).toMatchObject({ filters: null })
  })

  it('pages of fifty: next and previous move the offset', async () => {
    apolloFinto.risposte['GetIncidents'] = page([incident(1)], 120)
    const { user } = mount()
    expect(screen.getByText('120 incidents')).toBeInTheDocument()
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastQuery()).toMatchObject({ offset: 50 })
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(lastQuery()).toMatchObject({ offset: 0 })
  })

  it('sorting, filtering and paging start again from the first page and drop the selection', async () => {
    apolloFinto.risposte['GetIncidents'] = page([incident(1), incident(2)], 120)
    const { user } = mount()
    for (const act of [
      () => user.click(screen.getByRole('button', { name: 'Next →' })),
      () => user.click(screen.getByRole('button', { name: '← Prev' })),
      () => user.click(screen.getByRole('button', { name: 'Number' })),
      () => user.click(screen.getByRole('button', { name: 'apply status filter' })),
    ]) {
      await user.click(checkboxOf('Outage 1'))
      expect(toolbar()).toHaveTextContent('1 selected')
      await act()
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    }
    expect(lastQuery()).toMatchObject({ offset: 0, sortField: 'number' })
  })
})

describe('IncidentListPage: CSV export', () => {
  it('exports every filtered row in the current order, custom fields included, not only this page', async () => {
    csv.query.mockResolvedValue({ data: { incidents: { items: [incident(7), incident(8)] } } })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'apply status filter' }))
    await user.click(screen.getByRole('button', { name: 'Title' }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(csv.exportToCsv).toHaveBeenCalled())
    expect(csv.query).toHaveBeenCalledWith({
      query: GET_INCIDENTS, fetchPolicy: 'network-only',
      variables: { limit: 10000, offset: 0, filters: JSON.stringify(FILTER), sortField: 'title', sortDirection: 'asc' },
    })
    const [name, columns, rows] = csv.exportToCsv.mock.calls[0] as [string, Array<{ key: string }>, Array<Record<string, unknown>>]
    expect(name).toBe('incidents')
    expect(columns.map((c) => c.key)).toEqual(['number', 'title', 'severity', 'status', 'slaStatus', 'createdAt', 'cf:site'])
    expect(rows.map((r) => [r['number'], r['cf:site']])).toEqual([['INC00000007', 'Site 7'], ['INC00000008', 'Site 8']])
  })

  it('an answer without rows exports an empty file rather than failing', async () => {
    csv.query.mockResolvedValue({ data: undefined })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(csv.exportToCsv).toHaveBeenCalledWith('incidents', expect.any(Array), []))
  })
})

describe('IncidentListPage: acting on many incidents', () => {
  it('rows are selected one by one or all together, and the selection can be dropped', async () => {
    const { user } = mount()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    await user.click(checkboxOf('Outage 1'))
    await user.click(checkboxOf('Outage 3'))
    expect(toolbar()).toHaveTextContent('2 selected')
    await user.click(checkboxOf('Outage 3'))
    expect(toolbar()).toHaveTextContent('1 selected')
    const all = screen.getByRole('checkbox', { name: 'Select all (page)' })
    await user.click(all)
    expect(toolbar()).toHaveTextContent('3 selected')
    await user.click(all)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    await user.click(checkboxOf('Outage 2'))
    await user.click(within(toolbar()).getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })

  it('assigning to a team: the teams are read only then, a team is required, and every selected incident gets it', async () => {
    const { user } = mount()
    expect(apolloFinto.chiamate['GetTeams']).toBeUndefined()
    await user.click(checkboxOf('Outage 1'))
    await user.click(checkboxOf('Outage 2'))
    await user.click(within(toolbar()).getByRole('button', { name: 'Assign to team' }))
    const dialog = screen.getByRole('dialog', { name: 'Assign 2 incidents to a team' })
    expect(apolloFinto.chiamate['GetTeams']).toBeDefined()
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    await user.selectOptions(within(dialog).getByRole('combobox'), 't-mail')
    await user.click(confirm)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 completed'))
    expect(apolloFinto.chiamate['AssignIncidentToTeam']).toEqual([{ id: 'inc-1', teamId: 't-mail' }, { id: 'inc-2', teamId: 't-mail' }])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('resolving sends the trimmed note as root cause, or none', async () => {
    const { user } = mount()
    await user.click(checkboxOf('Outage 1'))
    await user.click(within(toolbar()).getByRole('button', { name: 'Resolve' }))
    const dialog = screen.getByRole('dialog', { name: 'Resolve 1 incident' })
    await user.type(within(dialog).getByPlaceholderText('Write here...'), '  Relay restarted  ')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(apolloFinto.chiamata('ResolveIncident')).toEqual({ id: 'inc-1', rootCause: 'Relay restarted' }))
    await user.click(checkboxOf('Outage 2'))
    await user.click(within(toolbar()).getByRole('button', { name: 'Resolve' }))
    // The note of the previous run is not carried over.
    expect(within(screen.getByRole('dialog')).getByPlaceholderText('Write here...')).toHaveValue('')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(apolloFinto.chiamata('ResolveIncident')).toEqual({ id: 'inc-2', rootCause: null }))
  })

  it('every selected incident is processed, and failures are counted, not hidden', async () => {
    apolloFinto.risposte['GetIncidents'] = page([1, 2, 3, 4, 5, 6, 7].map((n) => incident(n)))
    answerEach('ResolveIncident', (v) => (v?.['id'] === 'inc-6' ? { error: new Error('a workflow guard refused it') } : { data: { resolveIncident: { id: v?.['id'] } } }))
    const { user } = mount()
    await user.click(screen.getByRole('checkbox', { name: 'Select all (page)' }))
    await user.click(within(toolbar()).getByRole('button', { name: 'Resolve' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Resolve 7 incidents' })).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('6 completed, 1 failed'))
    expect(apolloFinto.chiamate['ResolveIncident']?.map((v) => v?.['id'])).toEqual(['inc-1', 'inc-2', 'inc-3', 'inc-4', 'inc-5', 'inc-6', 'inc-7'])
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('while a bulk action runs it cannot be dismissed or started again', async () => {
    hold('ResolveIncident')
    const { user } = mount()
    await user.click(checkboxOf('Outage 1'))
    await user.click(within(toolbar()).getByRole('button', { name: 'Resolve' }))
    const dialog = screen.getByRole('dialog', { name: 'Resolve 1 incident' })
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog).getByPlaceholderText('Write here...')).toBeDisabled()
    expect(within(toolbar()).getByRole('button', { name: 'Resolve' })).toBeDisabled()
    expect(within(toolbar()).getByRole('button', { name: 'Assign to team' })).toBeDisabled()
    await user.keyboard('{Escape}')
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog', { name: 'Resolve 1 incident' })).toBeInTheDocument()
    release('ResolveIncident')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 completed'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('the assignment, too, stays until it has reached every incident', async () => {
    hold('AssignIncidentToTeam')
    const { user } = mount()
    await user.click(checkboxOf('Outage 2'))
    await user.click(within(toolbar()).getByRole('button', { name: 'Assign to team' }))
    const dialog = screen.getByRole('dialog', { name: 'Assign 1 incident to a team' })
    await user.selectOptions(within(dialog).getByRole('combobox'), 't-net')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    expect(within(dialog).getByRole('combobox')).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Assign 1 incident to a team' })).toBeInTheDocument()
    release('AssignIncidentToTeam')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('AssignIncidentToTeam')).toEqual({ id: 'inc-2', teamId: 't-net' })
  })

  it('the dialogs can be left before starting, and nothing is sent', async () => {
    const { user } = mount()
    await user.click(checkboxOf('Outage 1'))
    await user.click(within(toolbar()).getByRole('button', { name: 'Assign to team' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(within(toolbar()).getByRole('button', { name: 'Resolve' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(within(toolbar()).getByRole('button', { name: 'Resolve' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await user.click(within(toolbar()).getByRole('button', { name: 'Assign to team' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['ResolveIncident']).toBeUndefined()
    expect(apolloFinto.chiamate['AssignIncidentToTeam']).toBeUndefined()
    // The selection survives a change of mind.
    expect(toolbar()).toHaveTextContent('1 selected')
  })
})
