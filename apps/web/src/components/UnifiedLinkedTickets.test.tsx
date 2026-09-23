/**
 * «LINKED TICKETS» on the incident, problem and change pages.
 *
 * One collapsible box: the total, the linked tickets grouped by kind (each
 * row opens its ticket and shows its step as the workflow names it), and a
 * «Link a ticket» panel that searches one kind at a time.
 *
 * What would hurt a user if it broke:
 * - the search runs on the SERVER (a list of the 50 newest filtered in the
 *   browser could not find an older ticket, and the user concluded it did not
 *   exist); it runs only while the panel is open, not on every page load;
 * - the results never offer the ticket itself nor what is already linked;
 * - an automatic link (a change linked by the system) shows a lock instead of
 *   an unlink button that would fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { LinkedTypeConfig, LinkedTicketItem, LinkedKind } from './UnifiedLinkedTickets'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { UnifiedLinkedTickets } = await import('./UnifiedLinkedTickets')

const item = (id: string, number: string, title: string, status = '', over: Partial<LinkedTicketItem> = {}): LinkedTicketItem =>
  ({ id, number, title, status, ...over })

function types(over: Partial<Record<LinkedKind, Partial<LinkedTypeConfig>>> = {}): LinkedTypeConfig[] {
  const base = (kind: LinkedKind, label: string, routeBase: string): LinkedTypeConfig => ({
    kind, label, routeBase, items: [], onLink: vi.fn(), onUnlink: vi.fn(), ...over[kind],
  })
  return [base('INCIDENT', 'Incident', '/incidents'), base('PROBLEM', 'Problem', '/problems'), base('CHANGE', 'Change', '/changes')]
}

const step = (name: string, label: string) => ({
  id: name, name, label, labels: [], type: 'state', isInitial: false, isTerminal: false, isOpen: true,
  category: null, purpose: null, order: 1,
})

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetWorkflowDefinition'] = (vars?: Record<string, unknown>) => ({
    workflowDefinition: {
      transitions: [],
      steps: vars?.['entityType'] === 'incident' ? [step('in_progress', 'Being worked on')] : [step('new', 'New')],
    },
  })
})

function mount(cfg: LinkedTypeConfig[], excludeId?: string) {
  return renderWithProviders(<UnifiedLinkedTickets title="Linked tickets" types={cfg} excludeId={excludeId} />)
}

/** The box starts closed: open it, as a user would. */
async function open(user: ReturnType<typeof mount>['user']) {
  await user.click(screen.getByRole('button', { name: /Linked tickets/ }))
}

const searchBox = () => screen.getByRole('textbox')

describe('UnifiedLinkedTickets — the linked tickets', () => {
  it('nothing linked: the count is 0 and, opened, the box says so', async () => {
    const { user } = mount(types())
    expect(screen.getByRole('button', { name: /Linked tickets/ })).toHaveTextContent('0')
    await open(user)
    expect(screen.getByText('No linked ticket.')).toBeInTheDocument()
  })

  it('groups the tickets by kind, with the total and the count per kind; empty kinds are left out', async () => {
    const cfg = types({
      INCIDENT: { items: [item('i1', 'INC001', 'Mail down', 'in_progress'), item('i2', 'INC002', 'VPN slow', 'weird_step')] },
      CHANGE: { items: [item('c1', 'CHG001', 'Patch mail server', 'new')] },
    })
    const { user } = mount(cfg)
    expect(screen.getByRole('button', { name: /Linked tickets/ })).toHaveTextContent('3')
    await open(user)
    expect(screen.getByText('INCIDENT')).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
    expect(screen.getByText('CHANGE')).toBeInTheDocument()
    expect(screen.getByText('(1)')).toBeInTheDocument()
    expect(screen.queryByText('PROBLEM')).not.toBeInTheDocument()
  })

  it('each row opens its ticket and shows its step as the workflow of that kind names it', async () => {
    const cfg = types({
      INCIDENT: { items: [
        item('i1', 'INC001', 'Mail down', 'in_progress'),
        item('i2', 'INC002', 'VPN slow', 'waiting_vendor'),
        item('i3', 'INC003', 'No status yet', ''),
      ] },
    })
    const { user } = mount(cfg)
    await open(user)
    expect(screen.getByRole('link', { name: 'INC001' })).toHaveAttribute('href', '/incidents/i1')
    const row = (n: string) => screen.getByRole('link', { name: n }).closest('div') as HTMLElement
    expect(within(row('INC001')).getByText('Being worked on')).toBeInTheDocument()
    // The step name of THIS kind's workflow: the problem workflow calls its steps otherwise.
    expect(apolloFinto.chiamate['GetWorkflowDefinition']).toContainEqual({ entityType: 'incident' })
    expect(within(row('INC003')).getByText('—')).toBeInTheDocument()
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the readable fallback
   * written after `labelFor` never applied, because `labelFor` gave back the
   * raw step name and so was never empty; the row showed «waiting_vendor».
   * `labelFor` now makes the name readable itself, for every caller.
   */
  it('a step the workflow does not know is shown readable, without underscores', async () => {
    const { user } = mount(types({ INCIDENT: { items: [item('i2', 'INC002', 'VPN slow', 'waiting_vendor')] } }))
    await open(user)
    const row = screen.getByRole('link', { name: 'INC002' }).closest('div') as HTMLElement
    expect(within(row).getByText('waiting vendor')).toBeInTheDocument()
  })

  it('the unlink button removes that ticket; an automatic link shows a lock instead', async () => {
    const onUnlink = vi.fn()
    const cfg = types({
      CHANGE: { onUnlink, items: [item('c1', 'CHG001', 'Manual link'), item('c2', 'CHG002', 'Auto link', '', { removable: false })] },
    })
    const { user } = mount(cfg)
    await open(user)
    const manual = screen.getByRole('link', { name: 'CHG001' }).closest('div') as HTMLElement
    const auto = screen.getByRole('link', { name: 'CHG002' }).closest('div') as HTMLElement
    expect(within(auto).queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument()
    expect(within(auto).getByTitle('Automatic link: it goes away only by deleting the change')).toBeInTheDocument()
    await user.click(within(manual).getByRole('button', { name: 'Unlink' }))
    expect(onUnlink).toHaveBeenCalledWith('c1')
  })
})

describe('UnifiedLinkedTickets — linking', () => {
  it('nothing is searched until the panel is opened', async () => {
    const { user } = mount(types())
    await open(user)
    expect(apolloFinto.chiamate['GetIncidents']).toBeUndefined()
    expect(apolloFinto.chiamate['GetProblems']).toBeUndefined()
    expect(apolloFinto.chiamate['GetChanges']).toBeUndefined()
  })

  it('the panel opens on the first kind, searches it on the server, and a result links it', async () => {
    const onLink = vi.fn()
    apolloFinto.risposte['GetIncidents'] = { incidents: { items: [item('i7', 'INC007', 'Printer jam'), item('i8', 'INC008', 'Disk full')] } }
    const { user } = mount(types({ INCIDENT: { onLink } }))
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(searchBox()).toHaveAttribute('placeholder', 'Search incident by number or title…')
    expect(searchBox()).toHaveFocus()
    // No term: the newest, without a filter.
    expect(apolloFinto.chiamata('GetIncidents')).toEqual({ limit: 50, filters: undefined })
    await user.type(searchBox(), 'jam')
    // The term goes to the server: number OR title contains it.
    expect(JSON.parse(String(apolloFinto.chiamata('GetIncidents')?.['filters']))).toEqual({ rules: [
      { id: 'n', field: 'number', operator: 'contains', value: 'jam', logic: 'OR' },
      { id: 't', field: 'title', operator: 'contains', value: 'jam', logic: 'OR' },
    ] })
    // …and the list narrows as the user types.
    expect(screen.queryByText('INC008')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /INC007/ }))
    expect(onLink).toHaveBeenCalledWith('i7')
  })

  it('never offers the ticket itself nor a ticket already linked', async () => {
    apolloFinto.risposte['GetProblems'] = { problems: { items: [
      item('p-self', 'PRB001', 'This problem'), item('p-linked', 'PRB002', 'Already linked'), item('p-new', 'PRB003', 'Candidate'),
    ] } }
    const cfg = types({ PROBLEM: { items: [item('p-linked', 'PRB002', 'Already linked')] } })
    const { user } = mount(cfg, 'p-self')
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    await user.click(screen.getByRole('button', { name: 'Problem' }))
    const results = screen.getByRole('textbox').parentElement as HTMLElement
    expect(within(results).queryByRole('button', { name: /PRB001/ })).not.toBeInTheDocument()
    expect(within(results).queryByRole('button', { name: /PRB002/ })).not.toBeInTheDocument()
    expect(within(results).getByRole('button', { name: /PRB003/ })).toBeInTheDocument()
  })

  it('problems are searched with the search argument; switching kind clears the term', async () => {
    apolloFinto.risposte['GetProblems'] = { problems: { items: [] } }
    const { user } = mount(types())
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    await user.type(searchBox(), 'x')
    await user.click(screen.getByRole('button', { name: 'Problem' }))
    expect(searchBox()).toHaveValue('')
    expect(searchBox()).toHaveAttribute('placeholder', 'Search problem by number or title…')
    expect(apolloFinto.chiamata('GetProblems')).toEqual({ search: undefined, limit: 20 })
    await user.type(searchBox(), ' leak ')
    expect(apolloFinto.chiamata('GetProblems')).toEqual({ search: 'leak', limit: 20 })
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('changes are searched by code, and read with their workflow step (or approval status)', async () => {
    const onLink = vi.fn()
    apolloFinto.risposte['GetChanges'] = { changes: { items: [
      { id: 'c1', code: 'CHG010', title: 'Firewall rule', approvalStatus: 'approved', workflowInstance: { currentStep: 'scheduled' } },
      { id: 'c2', code: 'CHG011', title: 'Router swap', approvalStatus: 'pending', workflowInstance: null },
      { id: 'c3', code: 'CHG012', title: 'Old change', approvalStatus: null, workflowInstance: null },
    ] } }
    const { user } = mount(types({ CHANGE: { onLink } }))
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.type(searchBox(), 'CHG01')
    expect(JSON.parse(String(apolloFinto.chiamata('GetChanges')?.['filters'])).rules[0]).toEqual(
      { id: 'n', field: 'code', operator: 'contains', value: 'CHG01', logic: 'OR' })
    await user.click(screen.getByRole('button', { name: /CHG011/ }))
    expect(onLink).toHaveBeenCalledWith('c2')
  })

  it('shows at most ten results', async () => {
    apolloFinto.risposte['GetIncidents'] = { incidents: { items: Array.from({ length: 14 }, (_, i) => item(`i${i}`, `INC1${String(i).padStart(2, '0')}`, `Ticket ${i}`)) } }
    const { user } = mount(types())
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    const results = searchBox().parentElement as HTMLElement
    expect(within(results).getAllByRole('button', { name: /INC1/ })).toHaveLength(10)
  })

  it('«Close» hides the panel and forgets the term', async () => {
    apolloFinto.risposte['GetIncidents'] = { incidents: { items: [] } }
    const { user } = mount(types())
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    await user.type(searchBox(), 'abc')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    expect(searchBox()).toHaveValue('')
  })

  it('a kind whose search has not answered yet shows no result, not an error', async () => {
    const { user } = mount(types())
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    expect(screen.getByText('No results')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Problem' }))
    expect(screen.getByText('No results')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change' }))
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('with no kind to link, the box still says there is nothing linked and offers no search', async () => {
    const { user } = mount([])
    await open(user)
    expect(screen.getByText('No linked ticket.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['GetIncidents']).toBeUndefined()
  })

  it('a page with a single kind opens the panel on it', async () => {
    const onLink = vi.fn()
    apolloFinto.risposte['GetChanges'] = { changes: { items: [{ id: 'c1', code: 'CHG001', title: 'Only changes here', approvalStatus: null, workflowInstance: null }] } }
    const only: LinkedTypeConfig[] = [{ kind: 'CHANGE', label: 'Change', routeBase: '/changes', items: [], onLink, onUnlink: vi.fn() }]
    const { user } = mount(only)
    await open(user)
    await user.click(screen.getByRole('button', { name: 'Link a ticket' }))
    await user.click(screen.getByRole('button', { name: /CHG001/ }))
    expect(onLink).toHaveBeenCalledWith('c1')
  })
})
