/**
 * THE SERVICE REQUEST LIST.
 *
 * Where the service desk finds the requests and the answers people gave to
 * the catalog forms. What it must get right:
 *  - the count and every column: the base ones, the tenant's custom fields,
 *    and the form fields the administrator chose to show «in the lists»
 *    (a multiple answer is joined, a missing one is a dash);
 *  - sorting, filtering and paging ask the SERVER — the list is paginated, and
 *    it used to stop at twenty rows with a count that said twenty (B-32) — and
 *    a new sort or filter starts again from the first page;
 *  - the CSV holds EVERY filtered row with the same columns, not only the page
 *    on screen (it used to export the twenty visible ones, silently).
 *
 * The filter builder is replaced by a stand-in that hands the page a filter
 * (it has its own tests); the table and the pagination are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { inFlight, resetInFlight } from '@/test/apolloInFlight'
import { formatDate } from '@/lib/datetime'
import { GET_SERVICE_REQUESTS } from '@/graphql/queries'
import { RequestListPage } from './RequestListPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())
const csv = vi.hoisted(() => ({ exportToCsv: vi.fn() }))
vi.mock('@/lib/csvExport', () => ({ exportToCsv: csv.exportToCsv }))
vi.mock('@/hooks/useEntityFields', () => ({ useEntityFields: () => ({ fields: [], error: null }) }))
const FILTER = { logic: 'and', rules: [{ field: 'priority', operator: 'eq', value: 'high' }] }
vi.mock('@/components/FilterBuilder', () => ({
  FilterBuilder: ({ onApply }: { onApply: (g: unknown) => void }) => (
    <div>
      <button type="button" onClick={() => onApply(FILTER)}>apply priority filter</button>
      <button type="button" onClick={() => onApply(null)}>clear filters</button>
    </div>
  ),
}))

const formValue = (name: string, displayValue: string | null, displayValues: string[] = []) => ({
  name, label: name, fieldType: 'text', displayValue, displayValues,
})
const request = (n: number, over: Record<string, unknown> = {}) => ({
  id: `sr-${n}`, number: `SR0000000${n}`, title: `Request ${n}`, priority: 'high', status: 'submitted',
  createdAt: '2026-09-21T09:00:00Z', customFields: [{ name: 'cost_centre', value: `CC-${n}` }],
  formFieldValues: [formValue('laptop_model', `Model ${n}`)], ...over,
})
const page = (items: unknown[], total = items.length) => ({ serviceRequests: { items, total } })

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  csv.exportToCsv.mockReset()
  apolloFinto.risposte['GetServiceRequests'] = page([
    request(1),
    request(2, { priority: 'low', formFieldValues: [formValue('laptop_model', null, ['Mouse', 'Dock'])] }),
    request(3, { formFieldValues: [], customFields: [] }),
  ])
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { transitions: [], steps: [
    { id: 's1', name: 'submitted', label: 'Sent', labels: [], type: 'state', isInitial: true, isTerminal: false, isOpen: true, category: 'active', purpose: null, order: 0 },
  ] } }
  apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [] }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ id: 'it-sr', name: 'service_request', label: 'Request', fields: [
    { id: 'f-cc', name: 'cost_centre', label: 'Cost centre', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false, enumTypeName: null, visibleToEndUser: true },
  ] }] }
  apolloFinto.risposte['GetFormFields'] = { formFields: [
    { name: 'laptop_model', label: 'Laptop model', inList: true },
    { name: 'justification', label: 'Justification', inList: false },
  ] }
})

const mount = () => renderWithProviders(<RequestListPage />, { route: '/requests' })
const lastQuery = () => apolloFinto.chiamata('GetServiceRequests')
const rowOf = (title: string) => screen.getByText(title).closest('tr') as HTMLElement

describe('RequestListPage: what the list shows', () => {
  it('the count and every column: base, custom fields, and the form fields shown in lists', () => {
    mount()
    expect(screen.getByText('3 requests')).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Number', 'Title', 'Priority', 'Status', 'Created', 'Cost centre', 'Laptop model'])
    const first = rowOf('Request 1')
    expect(within(first).getByText('SR00000001')).toBeInTheDocument()
    expect(within(first).getByText('Sent')).toBeInTheDocument()
    expect(within(first).getByTitle('high')).toHaveTextContent('High')
    expect(within(first).getByText(formatDate('2026-09-21T09:00:00Z'))).toBeInTheDocument()
    expect(within(first).getByText('CC-1')).toBeInTheDocument()
    expect(within(first).getByText('Model 1')).toBeInTheDocument()
    // Several answers are joined; a missing answer is a dash.
    expect(within(rowOf('Request 2')).getByText('Mouse, Dock')).toBeInTheDocument()
    expect(within(rowOf('Request 3')).getAllByText('—')).toHaveLength(2)
    expect(lastQuery()).toEqual({ limit: 50, offset: 0, filters: undefined, sortField: null, sortDirection: 'desc' })
  })

  it('a row opens its request', async () => {
    const { user } = mount()
    await user.click(screen.getByText('Request 2'))
    await attendiURL('/requests/sr-2')
  })

  it('"New Request" opens the creation form', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New Request' }))
    await attendiURL('/requests/new')
  })

  it('while the list loads the count waits', () => {
    inFlight.add('GetServiceRequests')
    mount()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/^\d+ requests?$/)).not.toBeInTheDocument()
  })

  it('no request: the empty state says what to do, and there is a single page', () => {
    apolloFinto.risposte['GetServiceRequests'] = page([])
    mount()
    expect(screen.getByText('0 requests')).toBeInTheDocument()
    expect(screen.getByText('No requests found')).toBeInTheDocument()
    expect(screen.getByText('Create a new service request.')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument()
  })

  it('a failed load shows the error with a retry, not an empty list', async () => {
    apolloFinto.erroriQuery['GetServiceRequests'] = new Error('requests unavailable')
    const { user } = mount()
    expect(screen.getByText('requests unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('RequestListPage: sorting, filtering, paging', () => {
  it('beyond fifty requests the others are one page away, and the count says them all', async () => {
    apolloFinto.risposte['GetServiceRequests'] = page([request(1)], 130)
    const { user } = mount()
    expect(screen.getByText('130 requests')).toBeInTheDocument()
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastQuery()).toMatchObject({ offset: 100 })
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(lastQuery()).toMatchObject({ offset: 50 })
  })

  it('a sort asks the server and starts from the first page; a second click reverses it', async () => {
    apolloFinto.risposte['GetServiceRequests'] = page([request(1)], 130)
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Priority' }))
    expect(lastQuery()).toMatchObject({ sortField: 'priority', sortDirection: 'asc', offset: 0 })
    await user.click(screen.getByRole('button', { name: 'Priority' }))
    expect(lastQuery()).toMatchObject({ sortField: 'priority', sortDirection: 'desc' })
  })

  it('a filter travels as JSON and starts from the first page; clearing it asks for everything', async () => {
    apolloFinto.risposte['GetServiceRequests'] = page([request(1)], 130)
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'apply priority filter' }))
    expect(lastQuery()).toMatchObject({ filters: JSON.stringify(FILTER), offset: 0 })
    await user.click(screen.getByRole('button', { name: 'clear filters' }))
    expect(lastQuery()).toMatchObject({ filters: undefined })
  })
})

describe('RequestListPage: CSV export', () => {
  it('asks the server for every filtered row in the current order, and exports them with the same columns', async () => {
    apolloFinto.query.mockResolvedValue({ data: page([request(7), request(8, { formFieldValues: [formValue('laptop_model', null, ['A', 'B'])] })]) })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'apply priority filter' }))
    await user.click(screen.getByRole('button', { name: 'Title' }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(csv.exportToCsv).toHaveBeenCalled())
    expect(apolloFinto.query).toHaveBeenCalledWith({
      query: GET_SERVICE_REQUESTS, fetchPolicy: 'network-only',
      variables: { limit: 10000, offset: 0, filters: JSON.stringify(FILTER), sortField: 'title', sortDirection: 'asc' },
    })
    const [name, columns, rows] = csv.exportToCsv.mock.calls[0] as [string, Array<{ key: string }>, Array<Record<string, unknown>>]
    expect(name).toBe('service-requests')
    expect(columns.map((c) => c.key)).toEqual(['number', 'title', 'priority', 'status', 'createdAt', 'cf:cost_centre', 'ff:laptop_model'])
    expect(rows.map((r) => [r['number'], r['cf:cost_centre'], r['ff:laptop_model']])).toEqual([['SR00000007', 'CC-7', 'Model 7'], ['SR00000008', 'CC-8', 'A, B']])
  })

  it('an answer without rows exports an empty file rather than failing', async () => {
    apolloFinto.query.mockResolvedValue({ data: undefined })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(csv.exportToCsv).toHaveBeenCalledWith('service-requests', expect.any(Array), []))
  })
})
