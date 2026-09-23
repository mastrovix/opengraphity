/**
 * THE TEAMS PAGE: the organization's teams, and where a new one is created.
 *
 * The list is sorted and filtered on the server, with sort, filters and page
 * kept in the address so a reload or a shared link shows the same view; the
 * type of a team is the customer's vocabulary (Dictionary → Team Type), read
 * with its labels, never a list written in the code.
 *
 * Creating a team needs a name, whether it is internal or external, and a
 * type — and neither of the last two is preselected: choosing «Internal» for
 * the administrator would decide exactly what the field exists to ask (the
 * OLA/UC contracts rely on it). What must not regress: «Create» stays off
 * until all three are given, an unreadable filter in the address is said
 * (F-17) rather than silently ignored, and a failed load is an error, not an
 * empty list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { exportToCsv } from '@/lib/csvExport'
import { formatDate } from '@/lib/datetime'
import { TeamsPage } from './TeamsPage'

// The shared fake answers at once: an operation named in `held` stays in flight.
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
      return held.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
    useMutation: (doc: Doc, opts?: Opts) => {
      const [fn, r] = m.useMutation(doc, opts)
      return held.has(nomeOperazione(doc)) ? [fn, { ...r, loading: true }] as const : [fn, r] as const
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/csvExport', () => ({ exportToCsv: vi.fn() }))

/** The customer's Team Type vocabulary: «vendor» is a value this customer added. */
const TEAM_TYPES = [
  { value: 'owner', label: 'Owner', labels: [] },
  { value: 'support', label: 'Support', labels: [] },
  { value: 'vendor', label: 'Supplier', labels: [] },
]
function withTeamTypes(ui: ReactElement, entries: typeof TEAM_TYPES | null = TEAM_TYPES): ReactElement {
  const value: DomainVocabularies = {
    valuesOf: (name) => (name === 'team_type' && entries ? entries.map((e) => e.value) : null),
    entriesOf: (name) => (name === 'team_type' ? entries : null),
    labelOf: (name, v) => (name === 'team_type' ? entries?.find((e) => e.value === v)?.label ?? null : null),
    colorOf: () => null,
    vocabularyLabelOf: () => null,
    loading: false,
    error: null,
  }
  return <DomainVocabularyContext.Provider value={value}>{ui}</DomainVocabularyContext.Provider>
}

const team = (over: Record<string, unknown> = {}) => ({
  id: 't1', name: 'Network', description: 'Routers and switches', type: 'support', sourcing: 'internal',
  createdAt: '2026-02-01T10:00:00Z', ...over,
})
const TEAMS = [
  team(),
  team({ id: 't2', name: 'Acme Hosting', description: null, type: 'vendor', sourcing: 'external' }),
  team({ id: 't3', name: 'Unsorted', description: null, type: null, sourcing: null }),
]

const renderPage = (route = '/teams', entries: typeof TEAM_TYPES | null = TEAM_TYPES) =>
  renderWithProviders(withTeamTypes(<TeamsPage />, entries), { route })

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent)

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  vi.mocked(exportToCsv).mockReset()
  apolloFinto.risposte['GetTeams'] = { teams: TEAMS }
})

describe('the list', () => {
  it('shows each team with its type as the customer names it, whether it is internal or external, and when it was created', () => {
    renderPage()
    expect(screen.getByText('3 teams')).toBeInTheDocument()
    const [network, hosting, unsorted] = bodyRows()
    expect(cells(network!)).toEqual(['Network', 'Routers and switches', 'Support', 'Internal', formatDate('2026-02-01T10:00:00Z')])
    expect(cells(hosting!).slice(2, 4)).toEqual(['Supplier', 'External'])
    // No type: a dash. No sourcing: said, because the OLA/UC contracts need it.
    expect(cells(unsorted!).slice(2, 4)).toEqual(['—', '— not set —'])
  })

  it('asks the server with no order and no filter at first', () => {
    renderPage()
    expect(apolloFinto.chiamata('GetTeams')).toEqual({ sortField: null, sortDirection: 'asc', filters: null })
  })

  it('the order in the address is the order asked of the server', () => {
    renderPage('/teams?sort=name:desc')
    expect(apolloFinto.chiamata('GetTeams')).toEqual({ sortField: 'name', sortDirection: 'desc', filters: null })
  })

  it('sorting a column writes it in the address', async () => {
    const { user } = renderPage()
    await user.click(within(screen.getByRole('columnheader', { name: /Name/ })).getByRole('button'))
    await attendiURL('/teams', { sort: 'name:asc' })
    expect(apolloFinto.chiamata('GetTeams')).toMatchObject({ sortField: 'name', sortDirection: 'asc' })
  })

  it('a row opens its team', async () => {
    const { user } = renderPage()
    await user.click(screen.getByText('Acme Hosting'))
    await attendiURL('/teams/t2')
  })

  it('shows fifty teams a page', async () => {
    apolloFinto.risposte['GetTeams'] = { teams: Array.from({ length: 60 }, (_, i) => team({ id: `t${i}`, name: `team-${String(i).padStart(2, '0')}` })) }
    const { user } = renderPage()
    expect(bodyRows()).toHaveLength(50)
    expect(screen.getByText('60 teams')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await attendiURL('/teams', { page: '2' })
    expect(bodyRows()).toHaveLength(10)
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    await attendiURL('/teams')
  })

  it('no team: says so', () => {
    apolloFinto.risposte['GetTeams'] = { teams: [] }
    renderPage()
    expect(screen.getByText('No teams')).toBeInTheDocument()
    expect(screen.getByText('There are no teams for this tenant.')).toBeInTheDocument()
  })

  it('a list that fails to load shows the error, and Retry reloads', async () => {
    apolloFinto.erroriQuery['GetTeams'] = new Error('teams unavailable')
    const { user } = renderPage()
    expect(screen.getByText('teams unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No teams')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('while the list loads the count is a dash', () => {
    held.add('GetTeams')
    renderPage()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('Export CSV exports the teams with the table columns', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledTimes(1))
    const [filename, columns, rows] = vi.mocked(exportToCsv).mock.calls[0]! as [string, { key: string }[], unknown[]]
    expect(filename).toBe('teams')
    expect(columns.map((c) => c.key)).toEqual(['name', 'description', 'type', 'sourcing', 'createdAt'])
    expect(rows).toEqual(TEAMS)
  })
})

describe('the filter', () => {
  it('offers the customer\'s team types and the two sourcings', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    const field = screen.getByRole('combobox', { name: 'Field of condition 1' })
    const values = () => within(screen.getByRole('combobox', { name: 'Value of condition 1' })).getAllByRole('option').map((o) => o.textContent)
    await user.selectOptions(field, 'type')
    expect(values()).toEqual(['Select', 'Owner', 'Support', 'Supplier'])
    await user.selectOptions(field, 'sourcing')
    expect(values()).toEqual(['Select', 'Internal', 'External'])
  })

  it('an applied filter goes in the address and to the server', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'sourcing')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Value of condition 1' }), 'external')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(new URLSearchParams(screen.getByTestId('location').textContent!.split('?')[1]).get('filters')).not.toBeNull())
    const { filters } = apolloFinto.chiamata('GetTeams') as { filters: string }
    expect(JSON.parse(filters).rules).toEqual([expect.objectContaining({ field: 'sourcing', operator: 'equals', value: 'external' })])
  })

  it('a filter in the address that cannot be read is said, not silently ignored (F-17)', () => {
    renderPage('/teams?filters=not-json')
    expect(screen.getByRole('alert')).toHaveTextContent('The advanced filter in this link cannot be read')
    expect(apolloFinto.chiamata('GetTeams')).toMatchObject({ filters: null })
  })
})

describe('creating a team', () => {
  it('«Create» stays off until the team has a name, a sourcing and a type — none of them preselected', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    const dialog = screen.getByRole('dialog', { name: 'New Team' })
    const create = within(dialog).getByRole('button', { name: 'Create' })
    expect(within(dialog).getByRole('radio', { name: 'Internal' })).not.toBeChecked()
    expect(within(dialog).getByRole('radio', { name: 'External' })).not.toBeChecked()
    expect(within(dialog).getByRole('combobox')).toHaveValue('')
    expect(create).toBeDisabled()
    await user.type(within(dialog).getByPlaceholderText('E.g. Network Operations'), '   ')
    await user.click(within(dialog).getByRole('radio', { name: 'External' }))
    await user.selectOptions(within(dialog).getByRole('combobox'), 'vendor')
    // A name made of spaces is no name.
    expect(create).toBeDisabled()
    await user.type(within(dialog).getByPlaceholderText('E.g. Network Operations'), 'Acme Support')
    expect(create).toBeEnabled()
  })

  it('sends the name and description trimmed, with the chosen sourcing and type, then closes, reloads and confirms', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    const dialog = screen.getByRole('dialog', { name: 'New Team' })
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Choose a type —', 'Owner', 'Support', 'Supplier'])
    await user.type(within(dialog).getByPlaceholderText('E.g. Network Operations'), '  Field Services  ')
    await user.click(within(dialog).getByRole('radio', { name: 'Internal' }))
    await user.selectOptions(within(dialog).getByRole('combobox'), 'support')
    await user.type(within(dialog).getAllByRole('textbox')[1]!, '  On-site repairs ')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(apolloFinto.chiamata('CreateTeam')).toEqual({ input: { name: 'Field Services', description: 'On-site repairs', type: 'support', sourcing: 'internal' } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Team created'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    // Opened again, the form is empty.
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    expect(within(screen.getByRole('dialog')).getByPlaceholderText('E.g. Network Operations')).toHaveValue('')
  })

  it('an empty description is sent as no description', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    const dialog = screen.getByRole('dialog', { name: 'New Team' })
    await user.type(within(dialog).getByPlaceholderText('E.g. Network Operations'), 'Field Services')
    await user.click(within(dialog).getByRole('radio', { name: 'Internal' }))
    await user.selectOptions(within(dialog).getByRole('combobox'), 'owner')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(apolloFinto.chiamata('CreateTeam')).toMatchObject({ input: { description: null } })
  })

  it('a creation the API refuses shows its reason and keeps the form', async () => {
    apolloFinto.esiti['CreateTeam'] = { error: new Error('a team with this name exists') }
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    const dialog = screen.getByRole('dialog', { name: 'New Team' })
    await user.type(within(dialog).getByPlaceholderText('E.g. Network Operations'), 'Network')
    await user.click(within(dialog).getByRole('radio', { name: 'Internal' }))
    await user.selectOptions(within(dialog).getByRole('combobox'), 'owner')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('a team with this name exists'))
    expect(screen.getByRole('dialog', { name: 'New Team' })).toBeInTheDocument()
  })

  it('Cancel, or the dialog\'s own close button, closes the form without creating', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamata('CreateTeam')).toBeUndefined()
  })

  it('while the team is being created the button says so and cannot be pressed again', async () => {
    held.add('CreateTeam')
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    const dialog = screen.getByRole('dialog', { name: 'New Team' })
    await user.type(within(dialog).getByPlaceholderText('E.g. Network Operations'), 'Field Services')
    await user.click(within(dialog).getByRole('radio', { name: 'Internal' }))
    await user.selectOptions(within(dialog).getByRole('combobox'), 'owner')
    expect(within(dialog).getByRole('button', { name: 'Creating…' })).toBeDisabled()
  })

  it('without a Team Type vocabulary the form says where to add the types', async () => {
    const { user } = renderPage('/teams', null)
    await user.click(screen.getByRole('button', { name: 'New Team' }))
    const dialog = screen.getByRole('dialog', { name: 'New Team' })
    expect(within(dialog).getByText('No team type in the dictionary: add the values in Settings → Dictionary → Team Type.')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Choose a type —'])
  })
})
