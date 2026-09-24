/**
 * THE LIST OF THE CIs OF ONE TYPE (`/ci/:typeName`).
 *
 * The page is built from the metamodel: the GraphQL query and mutation are
 * named after the type (`server` → `servers` / `createServer`), the filter
 * offers the base fields plus the type's own ones, and every value reads with
 * the label the customer gave it in the Dictionary. Sorting, filtering and
 * paging happen on the server, fifty CIs at a time; «Add» opens the form of
 * the type and then the new CI; «Export CSV» asks for every row, not just the
 * page on screen.
 *
 * What must not regress: the query must be the one of THIS type, a sort or a
 * filter must go back to the first page (otherwise it lands on an empty page
 * 3), the page must say «loading» and «type not found» apart, and a failed
 * load or a metamodel without the base values must be said, not shown as an
 * empty list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { withVocabularyLabels, SHIPPED_CI_LABELS } from '@/test/vocabularies'
import { apolloFinto } from '@/test/apolloFinto'
import { MetamodelContext, type CITypeDef, type CIFieldDef } from '@/contexts/MetamodelContext'
import { exportToCsv } from '@/lib/csvExport'
import { formatDate } from '@/lib/datetime'
import { CIListPage } from './CIListPage'

// The shared fake answers at once: a query named in `held` stays in flight.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useQuery>[0]
  type Opts = Parameters<typeof m.useQuery>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.has(nomeOperazione(doc)) && !opts?.skip ? { ...r, data: undefined, loading: true } : r
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const client = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/apollo', () => ({ apolloClient: client }))
vi.mock('@/lib/csvExport', () => ({ exportToCsv: vi.fn() }))
// The dynamic form has its own tests: here it submits known values.
vi.mock('@/components/CIDynamicForm', () => ({
  CIDynamicForm: ({ ciType, loading, onSubmit, onCancel }: {
    ciType: CITypeDef; loading: boolean; onSubmit: (v: Record<string, unknown>) => Promise<void>; onCancel: () => void
  }) => (
    <div>
      <span>{`form of ${ciType.name}`}</span>
      <button type="button" disabled={loading} onClick={() => void onSubmit({ name: 'web-03', environment: 'staging' }).catch(() => {})}>Submit form</button>
      <button type="button" onClick={onCancel}>Cancel form</button>
    </div>
  ),
}))

const field = (name: string, over: Partial<CIFieldDef> = {}): CIFieldDef => ({
  id: `f-${name}`, name, label: name, fieldType: 'string', required: false, enumValues: [], order: 1,
  isSystem: false, validationScript: null, visibilityScript: null, defaultScript: null, ...over,
})

const ciType = (name: string, label: string, fields: CIFieldDef[] = []): CITypeDef => ({
  id: `ct-${name}`, name, label, icon: 'server', color: '#000', active: true, scope: 'base', tenantId: 'system',
  validationScript: null, chainFamilies: [], serviceRole: null, fields, relations: [], systemRelations: [],
})

const SERVER = ciType('server', 'Server', [
  field('status', { label: 'Status', fieldType: 'enum', enumValues: ['active'], isSystem: true }),
  field('ip_address', { label: 'IP address' }),
  field('tier', { label: 'Tier', fieldType: 'enum', enumValues: ['gold', 'silver_plus'], enumTypeName: 'server_tier' }),
  field('os_family', { label: 'OS family', fieldType: 'enum', enumValues: ['linux'] }),
  field('eol', { label: 'End of life', fieldType: 'date' }),
])
const DB_INSTANCE = ciType('database_instance', 'Database Instance')

const ci = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'web-01', type: 'server', status: 'active', environment: 'production',
  createdAt: '2026-09-01T10:00:00Z', ownerGroup: { id: 't1', name: 'Platform' }, ...over,
})
const TWO = [ci(), ci({ id: 's2', name: 'web-02', status: null, environment: null, ownerGroup: null })]

const LABELS = { ...SHIPPED_CI_LABELS, server_tier: { gold: 'Gold' } }

function renderList(
  { route = '/ci/server', types = [SERVER, DB_INSTANCE], metamodel = {} }:
  { route?: string; types?: CITypeDef[]; metamodel?: Partial<{ loading: boolean; error: Error | null }> } = {},
) {
  const value = { ciTypes: types, loading: false, error: null, getCIType: (n: string) => types.find((t) => t.name === n), ...metamodel }
  return renderWithProviders(
    withVocabularyLabels(<MetamodelContext.Provider value={value}><CIListPage /></MetamodelContext.Provider>, LABELS),
    { route, path: '/ci/:typeName' },
  )
}

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
const openFilter = async (user: ReturnType<typeof renderList>['user']) => {
  await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
  await user.click(screen.getByRole('button', { name: 'Add filter' }))
}
const optionsOf = (name: string) => within(screen.getByRole('combobox', { name })).getAllByRole('option').map((o) => o.textContent)

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMe'] = { me: { id: 'u-me', name: 'Me', email: 'me@x', role: 'custom', roleName: null, permissions: ['cmdb.write'], teams: [] } }
  held.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  client.query.mockReset()
  vi.mocked(exportToCsv).mockReset()
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active', 'maintenance'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production', 'staging'] },
  ] } }
  apolloFinto.risposte['DynamicList_Server'] = { servers: { total: 2, items: TWO } }
})

describe('the list', () => {
  it('shows the CIs of the type with the customer labels, and how many there are', () => {
    renderList()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Server$/)
    expect(screen.getByText('2 configuration items')).toBeInTheDocument()
    const [first, second] = bodyRows()
    expect(within(first!).getAllByRole('cell').map((c) => c.textContent)).toEqual(
      ['web-01', 'Production', 'Active', 'Platform', formatDate('2026-09-01T10:00:00Z')],
    )
    // A CI without environment, state or group says so with a dash, not a blank.
    expect(within(second!).getAllByRole('cell').map((c) => c.textContent).slice(1, 4)).toEqual(['—', '—', '—'])
  })

  it('asks the server for the first fifty of THIS type, with no filter and no order', () => {
    renderList()
    expect(apolloFinto.chiamata('DynamicList_Server')).toEqual({ limit: 50, offset: 0, filters: null, sortField: null, sortDirection: 'asc' })
  })

  it('a type with an underscore is asked for by its GraphQL name', () => {
    apolloFinto.risposte['DynamicList_DatabaseInstance'] = { databaseInstances: { total: 1, items: [ci({ id: 'd1', name: 'orders-db', type: 'database_instance' })] } }
    renderList({ route: '/ci/database_instance' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Database Instance$/)
    expect(screen.getByText('orders-db')).toBeInTheDocument()
    expect(screen.getByText('1 configuration item')).toBeInTheDocument()
  })

  it('a row opens its CI', async () => {
    const { user } = renderList()
    await user.click(screen.getByText('web-02'))
    await attendiURL('/ci/server/s2')
  })

  it('sorting asks the server again from the first page; a second click reverses the order', async () => {
    apolloFinto.risposte['DynamicList_Server'] = { servers: { total: 120, items: TWO } }
    const { user } = renderList()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(apolloFinto.chiamata('DynamicList_Server')).toMatchObject({ offset: 50 })
    await user.click(within(screen.getByRole('columnheader', { name: /Name/ })).getByRole('button'))
    expect(apolloFinto.chiamata('DynamicList_Server')).toMatchObject({ offset: 0, sortField: 'name', sortDirection: 'asc' })
    await user.click(within(screen.getByRole('columnheader', { name: /Name/ })).getByRole('button'))
    expect(apolloFinto.chiamata('DynamicList_Server')).toMatchObject({ sortField: 'name', sortDirection: 'desc' })
  })

  it('pages through fifty CIs at a time', async () => {
    apolloFinto.risposte['DynamicList_Server'] = { servers: { total: 120, items: TWO } }
    const { user } = renderList()
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(apolloFinto.chiamata('DynamicList_Server')).toMatchObject({ offset: 50 })
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(apolloFinto.chiamata('DynamicList_Server')).toMatchObject({ offset: 0 })
  })

  it('a type with no CIs says there are none of it', () => {
    apolloFinto.risposte['DynamicList_Server'] = { servers: { total: 0, items: [] } }
    renderList()
    expect(screen.getByText('No Server')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('a list that fails to load shows the error instead of «no CIs», and Retry reloads it', async () => {
    apolloFinto.erroriQuery['DynamicList_Server'] = new Error('servers unavailable')
    const { user } = renderList()
    expect(screen.getByText('servers unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No Server')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('while the list loads the count is a dash and the table is not called empty', () => {
    held.add('DynamicList_Server')
    renderList()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('No Server')).toBeNull()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})

describe('the filter', () => {
  it('offers the base fields and the type\'s own ones — not its system fields', async () => {
    const { user } = renderList()
    await openFilter(user)
    expect(optionsOf('Field of condition 1')).toEqual([
      'Select field...', 'Name', 'Status', 'Environment', 'Owner Group', 'Chain', 'Created',
      'IP address', 'Tier', 'OS family', 'End of life',
    ])
  })

  it('reads every value with its Dictionary label, or the value made readable when it has none', async () => {
    const { user } = renderList()
    await openFilter(user)
    const fieldSelect = screen.getByRole('combobox', { name: 'Field of condition 1' })
    await user.selectOptions(fieldSelect, 'status')
    expect(optionsOf('Value of condition 1')).toEqual(['Select', 'Active', 'Maintenance'])
    await user.selectOptions(fieldSelect, 'environment')
    expect(optionsOf('Value of condition 1')).toEqual(['Select', 'Production', 'Staging'])
    await user.selectOptions(fieldSelect, 'tier')
    expect(optionsOf('Value of condition 1')).toEqual(['Select', 'Gold', 'Silver plus'])
    await user.selectOptions(fieldSelect, 'os_family')
    expect(optionsOf('Value of condition 1')).toEqual(['Select', 'Linux'])
    await user.selectOptions(fieldSelect, 'chain')
    expect(optionsOf('Value of condition 1')).toEqual(['Select', 'Application', 'Infrastructure'])
    await user.selectOptions(fieldSelect, 'eol')
    expect(screen.getByLabelText('Value of condition 1')).toHaveAttribute('type', 'date')
  })

  it('is applied on the server and starts again from the first page', async () => {
    apolloFinto.risposte['DynamicList_Server'] = { servers: { total: 120, items: TWO } }
    const { user } = renderList()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await openFilter(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'status')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Value of condition 1' }), 'maintenance')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const vars = apolloFinto.chiamata('DynamicList_Server') as { offset: number; filters: string }
    expect(vars.offset).toBe(0)
    expect(JSON.parse(vars.filters).rules).toEqual([expect.objectContaining({ field: 'status', operator: 'equals', value: 'maintenance' })])
  })

  it('without the base values from the metamodel, the page says they are missing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.erroriQuery['GetBaseCIType'] = new Error('metamodel down')
    renderList()
    expect(screen.getByText('Status/environment values unavailable from the metamodel (base type): metamodel down')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    // The list itself still works.
    expect(screen.getByText('web-01')).toBeInTheDocument()
  })
})

describe('before the list: the metamodel', () => {
  it('while the metamodel loads it says loading — not «type not found»', () => {
    renderList({ metamodel: { loading: true } })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText(/not found/)).toBeNull()
  })

  it('outside the app\'s metamodel provider the page waits for it instead of declaring the type unknown', () => {
    render(
      <MemoryRouter initialEntries={['/ci/server']}>
        <Routes><Route path="/ci/:typeName" element={<CIListPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('a metamodel that fails to load shows its error', () => {
    renderList({ metamodel: { error: new Error('metamodel unreachable') } })
    expect(screen.getByText('metamodel unreachable')).toBeInTheDocument()
  })

  it('a type the metamodel does not have is named in the message', () => {
    renderList({ route: '/ci/firewall' })
    expect(screen.getByText('CI type "firewall" not found.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('mounted on a route without a type it asks the server nothing', () => {
    const value = { ciTypes: [SERVER], loading: false, error: null, getCIType: (n: string) => [SERVER].find((t) => t.name === n) }
    renderWithProviders(<MetamodelContext.Provider value={value}><CIListPage /></MetamodelContext.Provider>, { route: '/ci', path: '/ci' })
    expect(screen.getByText('CI type "" not found.')).toBeInTheDocument()
    // Who the reader is (GetMe) is asked on every page; nothing about CIs is.
    expect(Object.keys(apolloFinto.chiamate).filter((op) => op !== 'GetBaseCIType' && op !== 'GetMe')).toEqual([])
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the list query was
   * skipped only without a `typeName`, so `/ci/firewall` still sent
   * `firewalls(...)`; the server refused it and a technical «Cannot query
   * field» toast stood next to the page's own «not found».
   */
  it('a type the metamodel does not have is not asked for', () => {
    renderList({ route: '/ci/firewall' })
    expect(apolloFinto.chiamata('DynamicList_Firewall')).toBeUndefined()
  })

  it('while the metamodel loads, or when it failed, the list is not asked for: the page says which, not «not found»', () => {
    // The real provider has no types until the metamodel has arrived.
    const { unmount } = renderList({ types: [], metamodel: { loading: true } })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    unmount()
    renderList({ types: [], metamodel: { error: new Error('metamodel unreachable') } })
    expect(screen.getByText('metamodel unreachable')).toBeInTheDocument()
    expect(screen.queryByText(/not found/)).toBeNull()
    expect(apolloFinto.chiamata('DynamicList_Server')).toBeUndefined()
  })
})

describe('adding a CI', () => {
  it('opens the form of the type; the new CI is created with its values and opened', async () => {
    apolloFinto.esiti['DynamicCreate_Server'] = { data: { createServer: { id: 's9', name: 'web-03' } } }
    const { user } = renderList()
    await user.click(screen.getByRole('button', { name: 'Add: Server' }))
    const dialog = screen.getByRole('dialog', { name: 'Add: Server' })
    expect(within(dialog).getByText('form of server')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Submit form' }))
    expect(apolloFinto.chiamata('DynamicCreate_Server')).toEqual({ input: { name: 'web-03', environment: 'staging' } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI «web-03» created (Server)'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    await attendiURL('/ci/server/s9')
  })

  it('an answer without the new CI closes the form and stays on the list', async () => {
    apolloFinto.esiti['DynamicCreate_Server'] = { data: { createServer: null } }
    const { user } = renderList()
    await user.click(screen.getByRole('button', { name: 'Add: Server' }))
    await user.click(screen.getByRole('button', { name: 'Submit form' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('CI «» created (Server)')
    await attendiURL('/ci/server')
  })

  it('a refused creation shows why and keeps the form open', async () => {
    apolloFinto.esiti['DynamicCreate_Server'] = { error: new Error('name already in use') }
    const { user } = renderList()
    await user.click(screen.getByRole('button', { name: 'Add: Server' }))
    await user.click(screen.getByRole('button', { name: 'Submit form' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('name already in use'))
    expect(screen.getByRole('dialog', { name: 'Add: Server' })).toBeInTheDocument()
  })

  it('cancelling, or closing the dialog, creates nothing', async () => {
    const { user } = renderList()
    await user.click(screen.getByRole('button', { name: 'Add: Server' }))
    await user.click(screen.getByRole('button', { name: 'Cancel form' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add: Server' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamata('DynamicCreate_Server')).toBeUndefined()
  })
})

describe('export', () => {
  it('asks for every CI with the current filter and order, and exports them with the table columns', async () => {
    const all = [...TWO, ci({ id: 's3', name: 'web-99' })]
    client.query.mockResolvedValue({ data: { servers: { total: 3, items: all } } })
    const { user } = renderList()
    await user.click(within(screen.getByRole('columnheader', { name: /Created/ })).getByRole('button'))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledTimes(1))
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({
      variables: { limit: 10000, offset: 0, filters: null, sortField: 'createdAt', sortDirection: 'asc' },
      fetchPolicy: 'network-only',
    }))
    const [filename, columns, rows] = vi.mocked(exportToCsv).mock.calls[0]! as [string, { key: string }[], unknown[]]
    expect(filename).toBe('server')
    expect(columns.map((c) => c.key)).toEqual(['name', 'environment', 'status', 'ownerGroup', 'createdAt'])
    expect(rows).toEqual(all)
  })

  it('the export carries the filter on screen', async () => {
    client.query.mockResolvedValue({ data: { servers: { total: 1, items: [ci()] } } })
    const { user } = renderList()
    await openFilter(user)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'name')
    await user.type(screen.getByRole('textbox', { name: 'Value of condition 1' }), 'web')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledTimes(1))
    const { filters } = (client.query.mock.calls[0]![0] as { variables: { filters: string } }).variables
    expect(JSON.parse(filters).rules).toEqual([expect.objectContaining({ field: 'name', operator: 'contains', value: 'web' })])
  })

  it('an answer without rows exports an empty file rather than failing', async () => {
    client.query.mockResolvedValue({ data: undefined })
    const { user } = renderList()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledWith('server', expect.any(Array), []))
  })
})

// Review of 23 Sep 2026: creating a CI asks cmdb.write, as the API does.
describe('CIListPage — who only reads the CMDB', () => {
  it('is not offered to add a CI', async () => {
    apolloFinto.risposte['GetMe'] = { me: { id: 'u-me', name: 'Me', email: 'me@x', role: 'custom', roleName: null, permissions: ['cmdb.read'], teams: [] } }
    renderList()
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^New|^Add/ })).toBeNull()
  })
})
