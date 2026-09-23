/**
 * THE LIST OF CHANGES.
 *
 * Where a Change Manager starts the day: every change with its phase, its
 * requester, its priority and its risk, filtered and sorted BY THE SERVER
 * (the list is paginated, so sorting or filtering only the page on screen
 * would lie). What these tests pin:
 *  - each row reads with the customer's words (the phase label of the
 *    workflow, the priority label of the Dictionary, the customer's fields),
 *    and a missing value is a dash, not an empty cell;
 *  - the phase and priority filters offer the customer's values and reach the
 *    query, and any new filter or sort restarts from the first page;
 *  - the CSV export carries the same filters as the screen (it did not: with
 *    "only critical" on, the file had every priority) and one column per
 *    customer field;
 *  - empty, failed and "just created" states each say what they are.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import type { FieldConfig, FilterGroup, FilterRule } from '@/components/FilterBuilder'
import { GET_CHANGES } from '@/graphql/queries'

const hoisted = vi.hoisted(() => ({
  exportQuery: vi.fn(),
  exportToCsv: vi.fn(),
  nextFilter: null as unknown,
  /** The first read of the list is still in flight. */
  loading: false,
}))

vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const fake = moduloApollo()
  return {
    ...fake,
    useQuery: (doc: Parameters<typeof nomeOperazione>[0], opts?: Parameters<typeof fake.useQuery>[1]) => {
      const r = fake.useQuery(doc, opts)
      return hoisted.loading && nomeOperazione(doc) === 'GetChanges' ? { ...r, data: undefined, loading: true } : r
    },
  }
})
vi.mock('@/lib/apollo', () => ({ apolloClient: { query: hoisted.exportQuery } }))
vi.mock('@/lib/csvExport', () => ({ exportToCsv: hoisted.exportToCsv }))
// The filter builder has its own tests: here it shows the fields the page offers
// and applies whatever group the test prepared.
vi.mock('@/components/FilterBuilder', () => ({
  FilterBuilder: ({ fields, onApply }: { fields: FieldConfig[]; onApply: (g: FilterGroup | null) => void }) => (
    <div>
      {fields.map((f) => <p key={f.key}>{`${f.label}: ${(f.options ?? []).map((o) => `${o.value}=${o.label}`).join(', ')}`}</p>)}
      <button type="button" onClick={() => onApply(hoisted.nextFilter as FilterGroup | null)}>apply filter</button>
    </div>
  ),
}))

const { ChangeListPage } = await import('./ChangeListPage')

const rule = (field: string, operator: FilterRule['operator'], value: FilterRule['value']): FilterRule =>
  ({ id: `${field}-${operator}`, field, operator, value, logic: 'AND' })

const step = (name: string, label: string, order: number, category = 'active') => ({
  id: `s-${name}`, name, label, labels: [], type: 'standard', isInitial: order === 1, isTerminal: false, isOpen: true,
  category, purpose: null, order,
})

const change = (over: Record<string, unknown> = {}) => ({
  id: 'c1', code: 'CHG00000001', title: 'Upgrade the orders database',
  workflowInstance: { id: 'wi-1', currentStep: 'implementation', status: 'running' },
  aggregateRiskScore: 42, priority: 'high', approvalRoute: null, approvalStatus: null,
  createdAt: '2026-09-14T08:00:00Z', updatedAt: '2026-09-14T08:00:00Z',
  requester: { id: 'u1', name: 'Rita Requester', email: 'r@x' }, changeOwner: null,
  customFields: [{ name: 'window', value: 'Sat 22:00' }],
  ...over,
})

const ROWS = [
  change(),
  change({
    id: 'c2', code: 'CHG00000002', title: 'Rotate the certificates', workflowInstance: null,
    aggregateRiskScore: null, priority: null, requester: null, customFields: [], createdAt: '2026-09-20T08:00:00Z',
  }),
]

/** The Dictionary: `emergency` is a customer priority that has no label yet. */
const VOCABULARIES: DomainVocabularies = {
  valuesOf: (name) => (name === 'priority' ? ['high', 'emergency'] : null),
  labelOf: (name, value) => (name === 'priority' && value === 'high' ? 'High' : null),
  entriesOf: () => null, colorOf: () => null, vocabularyLabelOf: () => null, loading: false, error: null,
}

const withDictionary = (ui: React.ReactElement) => <DomainVocabularyContext.Provider value={VOCABULARIES}>{ui}</DomainVocabularyContext.Provider>

beforeEach(() => {
  apolloFinto.reset()
  hoisted.exportQuery.mockReset()
  hoisted.exportToCsv.mockReset()
  hoisted.nextFilter = null
  hoisted.loading = false
  apolloFinto.risposte['GetChanges'] = { changes: { items: ROWS, total: 2 } }
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [
    step('assessment', 'Assessment', 1), step('implementation', 'Implementation', 2), step('closed', 'Closed', 3, 'closed'),
  ] } }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ id: 'it-c', name: 'change', label: 'Change', fields: [
    { id: 'f1', name: 'window', label: 'Maintenance window', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false, enumTypeName: null, visibleToEndUser: false },
    { id: 'f0', name: 'title', label: 'Title', fieldType: 'string', required: true, enumValues: [], order: 0, isSystem: true, enumTypeName: null, visibleToEndUser: true },
  ] }] }
})

const mount = () => renderWithProviders(withDictionary(<ChangeListPage />), { route: '/changes', path: '/changes' })

/** The text of every cell of every body row. */
const bodyRows = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))

const lastQuery = () => apolloFinto.chiamata('GetChanges')

describe('ChangeListPage — what each row says', () => {
  it('code, title, phase label, requester, priority label, risk, creation date and the customer field', () => {
    mount()
    expect(within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Code', 'Title', 'Phase', 'Requester', 'Priority', 'Risk', 'Created', 'Maintenance window'])
    expect(bodyRows()).toEqual([
      ['CHG00000001', 'Upgrade the orders database', 'Implementation', 'Rita Requester', 'High', '42', '14 Sept 2026', 'Sat 22:00'],
      // Nothing known is a dash; a change without a workflow has no phase to show.
      ['CHG00000002', 'Rotate the certificates', '', '—', '—', '—', '20 Sept 2026', '—'],
    ])
  })

  it('the header counts the changes', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeInTheDocument()
    expect(screen.getByText('2 changes')).toBeInTheDocument()
  })

  it('while the list loads it does not claim there is no change', () => {
    hoisted.loading = true
    mount()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('0 changes')).not.toBeInTheDocument()
    expect(screen.queryByText('No changes found')).not.toBeInTheDocument()
  })

  it('asks the server for the first page, newest first, with no filter', () => {
    mount()
    expect(lastQuery()).toEqual({ currentStep: null, priority: null, limit: 50, offset: 0, sortField: null, sortDirection: 'desc' })
  })

  it('a click on a row opens that change', async () => {
    const { user } = mount()
    await user.click(screen.getByText('Rotate the certificates'))
    await attendiURL('/changes/c2')
  })

  it('"New Change" opens the creation page', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New Change' }))
    await attendiURL('/changes/new')
  })

  it('no change at all: the empty state says what to do, and there are no pages', () => {
    apolloFinto.risposte['GetChanges'] = { changes: { items: [], total: 0 } }
    mount()
    expect(screen.getByText('No changes found')).toBeInTheDocument()
    expect(screen.getByText('Create the first change or adjust the applied filters.')).toBeInTheDocument()
    expect(screen.getByText('0 changes')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument()
  })

  it('a failed load shows the error instead of the table, and Retry reloads', async () => {
    apolloFinto.erroriQuery['GetChanges'] = new Error('changes unavailable')
    const { user } = mount()
    expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('changes unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('ChangeListPage — filter, sort and pages go to the server', () => {
  it('the filter offers the workflow phases and the customer priorities, by label', () => {
    mount()
    expect(screen.getByText('Phase: assessment=Assessment, implementation=Implementation, closed=Closed')).toBeInTheDocument()
    // A customer priority without a label is offered by its value, not dropped.
    expect(screen.getByText('Priority: high=High, emergency=emergency')).toBeInTheDocument()
  })

  // The label of a phase comes from `labelFor` alone, which always answers: a
  // `?? s.name` after it never ran and was removed (tour of 23 Sep 2026).
  it('a phase whose step has no label is offered by its name, never blank', () => {
    apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [
      step('assessment', 'Assessment', 1), step('rollback_pending', '', 2),
    ] } }
    mount()
    expect(screen.getByText(/^Phase: assessment=Assessment, rollback_pending=rollback[_ ]pending$/)).toBeInTheDocument()
  })

  it('while the Dictionary is not known the priority filter offers nothing, rather than invented values', () => {
    // The neutral style of a priority whose vocabulary is unknown is announced on the console: expected here.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderWithProviders(<ChangeListPage />, { route: '/changes' })
    expect(screen.getByText('Priority:')).toBeInTheDocument()
  })

  it('a filter on phase and priority reaches the query and restarts from the first page', async () => {
    apolloFinto.risposte['GetChanges'] = { changes: { items: ROWS, total: 120 } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastQuery()).toMatchObject({ offset: 50 })
    hoisted.nextFilter = { rules: [rule('currentStep', 'in', ['implementation', 'closed']), rule('priority', 'equals', 'high')] }
    await user.click(screen.getByRole('button', { name: 'apply filter' }))
    // A list of phases filters on the first one: the query takes one phase.
    expect(lastQuery()).toMatchObject({ currentStep: 'implementation', priority: 'high', offset: 0 })
  })

  it('only "equals" and "in" filter on the server; empty lists, blanks and a removed filter mean no filter', async () => {
    const { user } = mount()
    const apply = async (group: FilterGroup | null) => {
      hoisted.nextFilter = group
      await user.click(screen.getByRole('button', { name: 'apply filter' }))
      return lastQuery()
    }
    expect(await apply({ rules: [rule('currentStep', 'equals', 'closed'), rule('priority', 'in', ['emergency'])] }))
      .toMatchObject({ currentStep: 'closed', priority: 'emergency' })
    expect(await apply({ rules: [rule('currentStep', 'not_equals', 'closed')] }))
      .toMatchObject({ currentStep: null, priority: null })
    expect(await apply({ rules: [rule('currentStep', 'in', []), rule('priority', 'in', [])] }))
      .toMatchObject({ currentStep: null, priority: null })
    expect(await apply({ rules: [rule('currentStep', 'equals', null), rule('priority', 'equals', null)] }))
      .toMatchObject({ currentStep: null, priority: null })
    expect(await apply({ rules: [] })).toMatchObject({ currentStep: null, priority: null })
    expect(await apply(null)).toMatchObject({ currentStep: null, priority: null })
  })

  it('sorting a column asks the server for that order, first ascending then descending, from the first page', async () => {
    apolloFinto.risposte['GetChanges'] = { changes: { items: ROWS, total: 120 } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Code' }))
    expect(lastQuery()).toMatchObject({ sortField: 'code', sortDirection: 'asc', offset: 0 })
    expect(screen.getByRole('columnheader', { name: 'Code' })).toHaveAttribute('aria-sort', 'ascending')
    await user.click(screen.getByRole('button', { name: 'Code' }))
    expect(lastQuery()).toMatchObject({ sortField: 'code', sortDirection: 'desc' })
  })

  it('pages move by fifty, forward and back', async () => {
    apolloFinto.risposte['GetChanges'] = { changes: { items: ROWS, total: 120 } }
    const { user } = mount()
    const pages = screen.getByRole('navigation', { name: 'Pagination' })
    expect(within(pages).getByText('1 / 3')).toBeInTheDocument()
    await user.click(within(pages).getByRole('button', { name: 'Next →' }))
    expect(lastQuery()).toMatchObject({ offset: 50 })
    expect(within(pages).getByText('2 / 3')).toBeInTheDocument()
    await user.click(within(pages).getByRole('button', { name: '← Prev' }))
    expect(lastQuery()).toMatchObject({ offset: 0 })
  })
})

describe('ChangeListPage — reloading and exporting', () => {
  it('arriving from a change just created, the list reloads itself', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/changes', state: { refresh: true } }]}>
        {withDictionary(<ChangeListPage />)}
      </MemoryRouter>,
    )
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('arriving normally, it does not reload twice', () => {
    mount()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('the CSV carries the filters on screen, every row, the phase label and one column per customer field', async () => {
    hoisted.exportQuery.mockResolvedValue({ data: { changes: { items: [
      ...ROWS,
      change({ id: 'c3', code: 'CHG00000003', workflowInstance: { id: 'wi-3', currentStep: 'retired_step', status: 'running' }, customFields: null }),
    ] } } })
    const { user } = mount()
    hoisted.nextFilter = { rules: [rule('currentStep', 'equals', 'implementation'), rule('priority', 'equals', 'high')] }
    await user.click(screen.getByRole('button', { name: 'apply filter' }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(hoisted.exportToCsv).toHaveBeenCalledTimes(1))
    expect(hoisted.exportQuery).toHaveBeenCalledWith({
      query: GET_CHANGES,
      variables: { currentStep: 'implementation', priority: 'high', limit: 10000, offset: 0 },
      fetchPolicy: 'network-only',
    })
    const [name, columns, rows] = hoisted.exportToCsv.mock.calls[0]!
    expect(name).toBe('changes')
    expect(columns).toEqual([
      { key: 'code', label: 'Code' }, { key: 'title', label: 'Title' }, { key: 'phase', label: 'Phase' },
      { key: 'requester', label: 'Requester' }, { key: 'risk', label: 'Risk' }, { key: 'createdAt', label: 'Created' },
      { key: 'cf:window', label: 'Maintenance window' },
    ])
    expect(rows).toEqual([
      { code: 'CHG00000001', title: 'Upgrade the orders database', phase: 'Implementation', requester: 'Rita Requester', risk: 42, createdAt: '2026-09-14T08:00:00Z', 'cf:window': 'Sat 22:00' },
      { code: 'CHG00000002', title: 'Rotate the certificates', phase: '', requester: '', risk: null, createdAt: '2026-09-20T08:00:00Z' },
      // A step the workflow no longer has is exported by its name.
      { code: 'CHG00000003', title: 'Upgrade the orders database', phase: 'retired_step', requester: 'Rita Requester', risk: 42, createdAt: '2026-09-14T08:00:00Z' },
    ])
  })

  it('an export that finds nothing still writes the file with its header', async () => {
    hoisted.exportQuery.mockResolvedValue({ data: undefined })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(hoisted.exportToCsv).toHaveBeenCalledWith('changes', expect.any(Array), []))
  })
})
