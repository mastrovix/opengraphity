/**
 * THE LIST OF PROBLEMS, AND THE SEARCH FOR NEW ONES.
 *
 * Besides listing the problems (filtered, sorted and paginated by the server,
 * with the customer's labels and fields), this page is where a problem
 * manager asks the AI which clusters of recurring incidents deserve a
 * problem. What these tests pin:
 *  - the filter is sent to the server whole, and every new filter or sort
 *    starts again from the first page; the CSV export uses the same filter
 *    and sort as the screen;
 *  - the "Problem candidates" button works only with BOTH AI functions it
 *    needs turned on, and when one is off it says which one and who can turn
 *    it on — a dead button with no reason is what users reported;
 *  - an analysis that fails, or answers nothing, says so; one that answers
 *    shows the candidates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'
import type { FieldConfig, FilterGroup } from '@/components/FilterBuilder'
import { GET_PROBLEMS } from '@/graphql/queries'

const hoisted = vi.hoisted(() => ({
  exportQuery: vi.fn(),
  exportToCsv: vi.fn(),
  nextFilter: null as unknown,
  entityType: '',
  lazy: { run: vi.fn(), loading: false },
  /** The first read of the list is still in flight. */
  loading: false,
}))

// The fake Apollo, with a candidates analysis whose outcome each test decides
// (the shared fake cannot answer a lazy query with an error), and a list that
// can still be loading.
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const fake = moduloApollo()
  return {
    ...fake,
    useQuery: (doc: Parameters<typeof nomeOperazione>[0], opts?: Parameters<typeof fake.useQuery>[1]) => {
      const r = fake.useQuery(doc, opts)
      return hoisted.loading && nomeOperazione(doc) === 'GetProblems' ? { ...r, data: undefined, loading: true } : r
    },
    useLazyQuery: () => [hoisted.lazy.run, { loading: hoisted.lazy.loading }],
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/apollo', () => ({ apolloClient: { query: hoisted.exportQuery } }))
vi.mock('@/lib/csvExport', () => ({ exportToCsv: hoisted.exportToCsv }))
vi.mock('@/hooks/useEntityFields', () => ({
  useEntityFields: (typeName: string) => {
    hoisted.entityType = typeName
    return { fields: [{ key: 'status', label: 'Status', type: 'enum', options: [] }], error: null }
  },
}))
vi.mock('@/components/FilterBuilder', () => ({
  FilterBuilder: ({ fields, onApply }: { fields: FieldConfig[]; onApply: (g: FilterGroup | null) => void }) => (
    <div>
      <p>{`filter on: ${fields.map((f) => f.label).join(', ')}`}</p>
      <button type="button" onClick={() => onApply(hoisted.nextFilter as FilterGroup | null)}>apply filter</button>
    </div>
  ),
}))

const { ProblemListPage } = await import('./ProblemListPage')

const problem = (over: Record<string, unknown> = {}) => ({
  id: 'p1', number: 'PRB00000001', title: 'Checkout times out', priority: 'high', status: 'under_investigation',
  createdAt: '2026-09-14T08:00:00Z', customFields: [{ name: 'vendor_ref', value: 'V-42' }], ...over,
})

const ROWS = [
  problem(),
  problem({ id: 'p2', number: 'PRB00000002', title: 'Disk fills up', priority: 'low', status: 'known_error', createdAt: '2026-09-20T08:00:00Z', customFields: [] }),
]

const GROUP: FilterGroup = { rules: [{ id: 'r1', field: 'status', operator: 'equals', value: 'known_error', logic: 'AND' }] }

const step = (name: string, label: string, order: number) => ({
  id: `s-${name}`, name, label, labels: [], type: 'standard', isInitial: order === 1, isTerminal: false, isOpen: true,
  category: 'active', purpose: null, order,
})

const CANDIDATES = {
  candidates: [{ title: 'Checkout latency', motivation: 'Four incidents on the same gateway', incidents: [] }],
  examined: 12, notAnalysed: 0, analysisFailures: 0, capped: false,
}

const ai = (features: Record<string, boolean>) => ({ aiSettings: { features: { postIncident: true, embeddings: true, ...features } } })

beforeEach(() => {
  apolloFinto.reset()
  toast.error.mockReset()
  hoisted.exportQuery.mockReset()
  hoisted.exportToCsv.mockReset()
  hoisted.nextFilter = null
  hoisted.lazy.run = vi.fn(async () => ({ data: { problemCandidates: CANDIDATES } }))
  hoisted.lazy.loading = false
  hoisted.loading = false
  apolloFinto.risposte['GetProblems'] = { problems: { items: ROWS, total: 2 } }
  apolloFinto.risposte['GetAISettings'] = ai({})
  apolloFinto.risposte['GetMe'] = { me: { id: 'u1', name: 'Pat', email: 'p@x', role: 'custom', roleName: null, permissions: ['config.organization'], teams: [] } }
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [
    step('under_investigation', 'Under investigation', 1), step('known_error', 'Known error', 2),
  ] } }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ id: 'it-p', name: 'problem', label: 'Problem', fields: [
    { id: 'f1', name: 'vendor_ref', label: 'Vendor reference', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false, enumTypeName: null, visibleToEndUser: false },
  ] }] }
})

const mount = () => renderWithProviders(
  withVocabularyLabels(<ProblemListPage />, { priority: { high: 'High', low: 'Low' } }),
  { route: '/problems', path: '/problems' },
)

const bodyRows = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))
const lastQuery = () => apolloFinto.chiamata('GetProblems')
const candidatesButton = () => screen.getByRole('button', { name: /Problem candidates|Analysing…/ })

describe('ProblemListPage — the list', () => {
  it('each row shows number, title, priority label, step label, creation date and the customer field', () => {
    mount()
    expect(within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Number', 'Title', 'Priority', 'Status', 'Created', 'Vendor reference'])
    expect(bodyRows()).toEqual([
      ['PRB00000001', 'Checkout times out', 'High', 'Under investigation', '14 Sept 2026', 'V-42'],
      ['PRB00000002', 'Disk fills up', 'Low', 'Known error', '20 Sept 2026', '—'],
    ])
    expect(screen.getByText('2 problems')).toBeInTheDocument()
  })

  it('while the list loads it does not claim there is no problem', () => {
    hoisted.loading = true
    mount()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('0 problems')).not.toBeInTheDocument()
    expect(screen.queryByText('No problems found')).not.toBeInTheDocument()
  })

  it('asks for the first page, newest first, without filters', () => {
    mount()
    expect(lastQuery()).toEqual({ limit: 50, offset: 0, filters: null, sortField: null, sortDirection: 'desc' })
  })

  it('a click on a row opens the problem', async () => {
    const { user } = mount()
    await user.click(screen.getByText('Disk fills up'))
    await attendiURL('/problems/p2')
  })

  it('"New Problem" opens the creation form', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'New Problem' }))
    await attendiURL('/problems/new')
  })

  it('no problem: the empty state says what to do, and there is a single page', () => {
    apolloFinto.risposte['GetProblems'] = { problems: { items: [], total: 0 } }
    mount()
    expect(screen.getByText('No problems found')).toBeInTheDocument()
    expect(screen.getByText('Create a new problem or adjust the filters.')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument()
  })

  it('a failed load shows the error with a retry, not an empty table', async () => {
    apolloFinto.erroriQuery['GetProblems'] = new Error('problems unavailable')
    const { user } = mount()
    expect(screen.getByText('problems unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('ProblemListPage — filter, sort, pages and export', () => {
  it('the filter offers the fields of the Problem entity and is sent whole, from the first page', async () => {
    apolloFinto.risposte['GetProblems'] = { problems: { items: ROWS, total: 120 } }
    const { user } = mount()
    expect(hoisted.entityType).toBe('Problem')
    expect(screen.getByText('filter on: Status')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(lastQuery()).toMatchObject({ offset: 50 })
    hoisted.nextFilter = GROUP
    await user.click(screen.getByRole('button', { name: 'apply filter' }))
    expect(lastQuery()).toMatchObject({ offset: 0, filters: JSON.stringify(GROUP) })
    hoisted.nextFilter = null
    await user.click(screen.getByRole('button', { name: 'apply filter' }))
    expect(lastQuery()).toMatchObject({ filters: null })
  })

  it('sorting asks the server, ascending then descending, from the first page', async () => {
    apolloFinto.risposte['GetProblems'] = { problems: { items: ROWS, total: 120 } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: 'Title' }))
    expect(lastQuery()).toMatchObject({ sortField: 'title', sortDirection: 'asc', offset: 0 })
    await user.click(screen.getByRole('button', { name: 'Title' }))
    expect(lastQuery()).toMatchObject({ sortField: 'title', sortDirection: 'desc' })
  })

  it('pages move by fifty, forward and back', async () => {
    apolloFinto.risposte['GetProblems'] = { problems: { items: ROWS, total: 120 } }
    const { user } = mount()
    const pages = screen.getByRole('navigation', { name: 'Pagination' })
    expect(within(pages).getByText('1 / 3')).toBeInTheDocument()
    await user.click(within(pages).getByRole('button', { name: 'Next →' }))
    expect(lastQuery()).toMatchObject({ offset: 50 })
    await user.click(within(pages).getByRole('button', { name: '← Prev' }))
    expect(lastQuery()).toMatchObject({ offset: 0 })
  })

  it('the CSV has every row of the same filter and sort, with the customer fields', async () => {
    hoisted.exportQuery.mockResolvedValue({ data: { problems: { items: ROWS } } })
    const { user } = mount()
    hoisted.nextFilter = GROUP
    await user.click(screen.getByRole('button', { name: 'apply filter' }))
    await user.click(screen.getByRole('button', { name: 'Created' }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(hoisted.exportToCsv).toHaveBeenCalledTimes(1))
    expect(hoisted.exportQuery).toHaveBeenCalledWith({
      query: GET_PROBLEMS,
      variables: { limit: 10000, offset: 0, filters: JSON.stringify(GROUP), sortField: 'createdAt', sortDirection: 'asc' },
      fetchPolicy: 'network-only',
    })
    const [name, columns, rows] = hoisted.exportToCsv.mock.calls[0]!
    expect(name).toBe('problems')
    expect((columns as Array<{ key: string }>).map((c) => c.key)).toEqual(['number', 'title', 'priority', 'status', 'createdAt', 'cf:vendor_ref'])
    expect(rows).toEqual([
      expect.objectContaining({ number: 'PRB00000001', 'cf:vendor_ref': 'V-42' }),
      expect.objectContaining({ number: 'PRB00000002' }),
    ])
  })

  it('an export that finds nothing writes an empty file, without a filter', async () => {
    hoisted.exportQuery.mockResolvedValue({ data: undefined })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(hoisted.exportToCsv).toHaveBeenCalledWith('problems', expect.any(Array), []))
    expect(hoisted.exportQuery).toHaveBeenCalledWith(expect.objectContaining({ variables: expect.objectContaining({ filters: null }) }))
  })
})

describe('ProblemListPage — problem candidates from recurring incidents', () => {
  it('with both AI functions on, the analysis shows the candidates it found', async () => {
    const { user } = mount()
    expect(candidatesButton()).toBeEnabled()
    expect(candidatesButton()).not.toHaveAttribute('title')
    await user.click(candidatesButton())
    expect(hoisted.lazy.run).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Checkout latency')).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('an analysis that fails says why, and shows no candidates', async () => {
    hoisted.lazy.run = vi.fn(async () => ({ error: new Error('model unavailable') }))
    const { user } = mount()
    await user.click(candidatesButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Analysis failed: model unavailable'))
    expect(screen.queryByText('Problem candidates from recurring incidents')).not.toBeInTheDocument()
  })

  it('an analysis that answers nothing says so', async () => {
    hoisted.lazy.run = vi.fn(async () => ({}))
    const { user } = mount()
    await user.click(candidatesButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Analysis failed: no response'))
  })

  it('while the analysis runs the button says so and cannot be pressed again', () => {
    hoisted.lazy.loading = true
    mount()
    expect(candidatesButton()).toHaveTextContent('Analysing…')
    expect(candidatesButton()).toBeDisabled()
  })

  it('with the post-incident analysis off it is off, and tells an administrator where to turn it on', () => {
    apolloFinto.risposte['GetAISettings'] = ai({ postIncident: false })
    mount()
    expect(candidatesButton()).toBeDisabled()
    expect(candidatesButton()).toHaveAttribute('title', '«Post-incident notes and problem candidates» is turned off: turn it on in Organization → AI.')
  })

  it('with similarity off it names that function, and tells a user to ask an administrator', () => {
    apolloFinto.risposte['GetAISettings'] = ai({ embeddings: false })
    apolloFinto.risposte['GetMe'] = { me: { id: 'u2', name: 'Ugo', email: 'u@x', role: 'custom', roleName: null, permissions: [], teams: [] } }
    mount()
    expect(candidatesButton()).toBeDisabled()
    expect(candidatesButton()).toHaveAttribute('title', '«Similarity (embeddings)» is turned off for your organization: an administrator can turn it on.')
  })

  it('while the AI settings are unknown it is off, without claiming a function is turned off', () => {
    apolloFinto.risposte['GetAISettings'] = undefined
    mount()
    expect(candidatesButton()).toBeDisabled()
    expect(candidatesButton()).not.toHaveAttribute('title')
  })
})
