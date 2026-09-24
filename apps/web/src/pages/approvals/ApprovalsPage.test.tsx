/**
 * APPROVALS: where a person decides what is waiting for them.
 *
 * The page has two lists. «Pending my approval» holds the requests this person
 * decides here (approve with an optional note, reject with a mandatory reason)
 * and the ticket approvals that are decided on the ticket page, which only
 * link there. «All» is the register of every request, filterable and paged,
 * where a pending request can be cancelled.
 *
 * What must not regress: a rejection without a reason must never reach the
 * API (the requester would get a «no» without knowing why), an approval must
 * send the note that was typed and nothing else, a cancellation must be
 * confirmed first, the counts and filters must cover every kind of approval
 * the product creates, and a failed load must say so instead of looking like
 * «nothing to approve».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { formatDate, formatDateTime } from '@/lib/datetime'
import { ApprovalsPage } from './ApprovalsPage'

// The shared fake answers every query at once and runs a lazy query before it
// is asked to: here a query named in `held.queries` stays in flight, and a lazy
// query has no data until it is RUN (then it answers, fails or stays in flight).
const held = vi.hoisted(() => ({ queries: new Set<string>(), lazy: new Set<string>() }))
vi.mock('@apollo/client/react', async () => {
  const { useState } = await import('react')
  const { apolloFinto: finto, nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useQuery>[0]
  type Opts = Parameters<typeof m.useQuery>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.queries.has(nomeOperazione(doc)) && !opts?.skip ? { ...r, data: undefined, loading: true } : r
    },
    useLazyQuery: (doc: Doc) => {
      const nome = nomeOperazione(doc)
      const [state, setState] = useState<{ data?: unknown; loading: boolean; error?: Error }>({ loading: false })
      const run = async (o: { variables?: Record<string, unknown> } = {}) => {
        ;(finto.chiamate[nome] ??= []).push(o.variables)
        if (held.lazy.has(nome)) { setState({ loading: true }); return { data: undefined } }
        const error = finto.erroriQuery[nome]
        const data = error ? undefined : finto.risposte[nome]
        setState({ data, loading: false, error })
        return { data, error }
      }
      return [run, { ...state, called: true }] as const
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

interface ApprovalFixture {
  id: string; entityType: string; entityId: string; title: string; description: string | null
  status: string; requestedBy: string; requestedAt: string; approvers: string[]; approvedBy: string[]
  rejectedBy: string | null; approvalType: string; dueDate: string | null; resolvedAt: string | null
  resolutionNote: string | null
}

const approval = (over: Partial<ApprovalFixture> = {}): ApprovalFixture => ({
  id: 'a1', entityType: 'change', entityId: 'chg-1', title: 'Upgrade the core switch',
  description: 'Firmware 9.2 on both members', status: 'pending', requestedBy: 'u-1',
  requestedAt: '2026-09-10T08:30:00Z', approvers: ['u-2', 'u-3', 'u-4'], approvedBy: ['u-2'],
  rejectedBy: null, approvalType: 'all', dueDate: '2026-09-12T00:00:00Z', resolvedAt: null,
  resolutionNote: null, ...over,
})

const ticketApproval = (over: Record<string, unknown> = {}) => ({
  kind: 'change', entityId: 'chg-7', number: 'CHG00000007', title: 'Rotate the certificates',
  detail: 'Network', approvalKind: 'change_manager', requestedAt: '2026-09-11T07:00:00Z', onBehalf: false, ...over,
})

const KB_ARTICLE = {
  id: 'kb-1', title: 'How to connect to the VPN', body: '## Steps\n\nOpen the **client** and sign in.',
  category: 'Networking', tags: ['vpn', 'remote'], status: 'draft', authorName: 'Anna Bianchi',
  updatedAt: '2026-09-01T09:00:00Z',
}

beforeEach(() => {
  apolloFinto.reset()
  held.queries.clear()
  held.lazy.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  // The customer's names for the ITIL types: «Disruption» is what this customer calls an incident.
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [
    { name: 'change', label: 'Change' }, { name: 'incident', label: 'Disruption' },
    { name: 'problem', label: 'Problem' }, { name: 'service_request', label: 'Service Request' },
  ] }
  apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [] }
  apolloFinto.risposte['PendingTicketApprovals'] = { pendingTicketApprovals: [] }
  apolloFinto.risposte['AllApprovals'] = { approvalRequests: { items: [], total: 0 } }
})

afterEach(() => { vi.restoreAllMocks() })

/** The card of a request, found by its title. */
const card = (title: string) => screen.getByRole('heading', { name: new RegExp(title) }).closest('div[style*="border"]') as HTMLElement

const mineTab = () => screen.getByRole('button', { name: /^Pending my approval/ })
const allTab = () => screen.getByRole('button', { name: 'All' })

describe('Pending my approval', () => {
  it('a request shows its state, the customer name of its type, how it is decided, its progress and its ticket', () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval()] }
    renderWithProviders(<ApprovalsPage />)
    const c = card('Upgrade the core switch')
    expect(within(c).getByText('Pending')).toBeInTheDocument()
    expect(within(c).getByText('Change')).toBeInTheDocument()
    expect(within(c).getByText('every required approver')).toBeInTheDocument()
    expect(within(c).getByText('Firmware 9.2 on both members')).toBeInTheDocument()
    expect(within(c).getByText(formatDateTime('2026-09-10T08:30:00Z'))).toBeInTheDocument()
    expect(within(c).getByText('1/3 approvals')).toBeInTheDocument()
    expect(within(c).getByText(`Due: ${formatDate('2026-09-12T00:00:00Z')}`)).toBeInTheDocument()
    expect(within(c).getByRole('link', { name: /Open the ticket/ })).toHaveAttribute('href', '/changes/chg-1')
  })

  it('says whether one approver, all of them or a majority is needed', () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [
      approval({ id: 'a1', title: 'Any one', approvalType: 'any' }),
      approval({ id: 'a2', title: 'Every one', approvalType: 'all' }),
      approval({ id: 'a3', title: 'Most of them', approvalType: 'majority' }),
    ] }
    renderWithProviders(<ApprovalsPage />)
    expect(within(card('Any one')).getByText('1 approver is enough')).toBeInTheDocument()
    expect(within(card('Every one')).getByText('every required approver')).toBeInTheDocument()
    expect(within(card('Most of them')).getByText('a majority is required')).toBeInTheDocument()
  })

  it('each ticket type links to its own page, with the name the customer gave the type', () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [
      approval({ id: 'a1', title: 'Outage', entityType: 'incident', entityId: 'inc-1', description: null, dueDate: null }),
      approval({ id: 'a2', title: 'Root cause', entityType: 'problem', entityId: 'prb-1' }),
      approval({ id: 'a3', title: 'Laptop', entityType: 'service_request', entityId: 'sr-1' }),
    ] }
    renderWithProviders(<ApprovalsPage />)
    const outage = card('Outage')
    expect(within(outage).getByText('Disruption')).toBeInTheDocument()
    expect(within(outage).getByRole('link', { name: /Open the ticket/ })).toHaveAttribute('href', '/incidents/inc-1')
    // No description and no due date: nothing is printed in their place.
    expect(within(outage).queryByText(/^Due:/)).toBeNull()
    expect(within(card('Root cause')).getByRole('link', { name: /Open the ticket/ })).toHaveAttribute('href', '/problems/prb-1')
    expect(within(card('Laptop')).getByRole('link', { name: /Open the ticket/ })).toHaveAttribute('href', '/requests/sr-1')
  })

  it('the tab counts both the requests decided here and those decided on the ticket', () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval()] }
    apolloFinto.risposte['PendingTicketApprovals'] = { pendingTicketApprovals: [ticketApproval()] }
    renderWithProviders(<ApprovalsPage />)
    expect(mineTab()).toHaveTextContent(/^Pending my approval2$/)
  })

  it('what I can decide only for another team is shown apart, outside the count (24 Sep 2026)', () => {
    apolloFinto.risposte['PendingTicketApprovals'] = { pendingTicketApprovals: [
      ticketApproval(),
      ticketApproval({ entityId: 'chg-9', title: 'Replace the storage', detail: 'Storage', onBehalf: true }),
    ] }
    renderWithProviders(<ApprovalsPage />)
    expect(mineTab()).toHaveTextContent(/^Pending my approval1$/)
    const apart = screen.getByRole('region', { name: '1 approval you can decide for another team' })
    expect(within(apart).getByText(/Replace the storage/)).toBeInTheDocument()
    expect(within(apart).queryByText(/Rotate the certificates/)).toBeNull()
  })

  it('with only approvals of other teams, mine is empty and says so, and theirs are still listed', () => {
    apolloFinto.risposte['PendingTicketApprovals'] = { pendingTicketApprovals: [ticketApproval({ onBehalf: true })] }
    renderWithProviders(<ApprovalsPage />)
    expect(screen.getByText('No pending approvals')).toBeInTheDocument()
    expect(within(screen.getByRole('region')).getByText(/Rotate the certificates/)).toBeInTheDocument()
  })

  it('approving sends the note that was typed, confirms, and reloads the lists', async () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval()] }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(within(card('Upgrade the core switch')).getByRole('button', { name: 'Approve' }))
    await user.type(screen.getByPlaceholderText('Optional note...'), 'Fine after the change window')
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }))
    expect(apolloFinto.chiamata('ApproveRequest')).toEqual({ id: 'a1', note: 'Fine after the change window' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Approval recorded'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    // The note box closes once the decision is sent.
    expect(screen.queryByPlaceholderText('Optional note...')).toBeNull()
  })

  it('an approval without a note sends no note at all, not an empty one', async () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval()] }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }))
    expect(apolloFinto.chiamata('ApproveRequest')).toEqual({ id: 'a1', note: undefined })
  })

  it('a rejection without a reason is refused before it reaches the API', async () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval()] }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const reason = screen.getByPlaceholderText('Reason for the rejection (required)...')
    await user.type(reason, '   ')
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }))
    expect(toast.error).toHaveBeenCalledWith('A rejection reason is required')
    expect(apolloFinto.chiamata('RejectRequest')).toBeUndefined()
    // The box stays open with what was typed, so the reason can be added.
    await user.clear(reason)
    await user.type(reason, 'No rollback plan')
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }))
    expect(apolloFinto.chiamata('RejectRequest')).toEqual({ id: 'a1', note: 'No rollback plan' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Request rejected'))
  })

  it('the decision box toggles, switches between approve and reject, and Cancel throws away what was typed', async () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval()] }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.getByPlaceholderText('Optional note...')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.queryByPlaceholderText('Optional note...')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await user.type(screen.getByPlaceholderText('Reason for the rejection (required)...'), 'Half a thought')
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.queryByPlaceholderText('Reason for the rejection (required)...')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.getByPlaceholderText('Reason for the rejection (required)...')).toHaveValue('')
    expect(apolloFinto.chiamata('RejectRequest')).toBeUndefined()
  })

  it('a decision the API refuses shows its message', async () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval()] }
    apolloFinto.esiti['ApproveRequest'] = { error: new Error('The approval window is closed') }
    apolloFinto.esiti['RejectRequest'] = { error: new Error('Already decided') }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The approval window is closed'))
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await user.type(screen.getByPlaceholderText('Reason for the rejection (required)...'), 'No')
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already decided'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a ticket approval says which part is approved and sends the approver to the ticket, with no decision here', () => {
    apolloFinto.risposte['PendingTicketApprovals'] = { pendingTicketApprovals: [
      ticketApproval(),
      ticketApproval({ kind: 'service_request', entityId: 'sr-3', number: null, title: 'New laptop', detail: 'Manager approval', approvalKind: null, requestedAt: null }),
      ticketApproval({ entityId: 'chg-8', number: 'CHG00000008', title: 'Patch the firewall', detail: null, approvalKind: 'security_board' }),
    ] }
    renderWithProviders(<ApprovalsPage />)
    const change = card('Rotate the certificates')
    expect(within(change).getByRole('heading')).toHaveTextContent('CHG00000007 · Rotate the certificates')
    expect(within(change).getByText('for team Network')).toBeInTheDocument()
    expect(within(change).getByText('Change Manager')).toBeInTheDocument()
    expect(within(change).getByText(formatDateTime('2026-09-11T07:00:00Z'))).toBeInTheDocument()
    expect(within(change).getByText('You approve or reject it in the ticket page.')).toBeInTheDocument()
    expect(within(change).getByRole('link', { name: /Open the ticket/ })).toHaveAttribute('href', '/changes/chg-7')

    const request = card('New laptop')
    expect(within(request).getByRole('heading')).toHaveTextContent(/^New laptop$/)
    expect(within(request).getByText('Service Request')).toBeInTheDocument()
    expect(within(request).getByText('step: Manager approval')).toBeInTheDocument()
    expect(within(request).getByRole('link', { name: /Open the ticket/ })).toHaveAttribute('href', '/requests/sr-3')

    // A part the client has no name for shows its key rather than disappearing.
    expect(within(card('Patch the firewall')).getByText('security_board')).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('with nothing waiting it says so, and the tab carries no count', () => {
    renderWithProviders(<ApprovalsPage />)
    expect(screen.getByText('No pending approvals')).toBeInTheDocument()
    expect(mineTab()).toHaveTextContent(/^Pending my approval$/)
  })

  it('a list that fails to load shows the error instead of «nothing pending», and Retry reloads both lists', async () => {
    apolloFinto.erroriQuery['MyPendingApprovals'] = new Error('approvals unavailable')
    const { user } = renderWithProviders(<ApprovalsPage />)
    expect(screen.getByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('approvals unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No pending approvals')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(2)
  })

  it('the ticket approvals failing is an error too', () => {
    apolloFinto.erroriQuery['PendingTicketApprovals'] = new Error('ticket approvals unavailable')
    renderWithProviders(<ApprovalsPage />)
    expect(screen.getByText('ticket approvals unavailable')).toBeInTheDocument()
  })

  it('while my approvals load the page says it is loading', () => {
    held.queries.add('MyPendingApprovals')
    renderWithProviders(<ApprovalsPage />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No pending approvals')).toBeNull()
  })
})

describe('the preview of a KB article waiting for approval', () => {
  beforeEach(() => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [
      approval({ entityType: 'kb_article', entityId: 'kb-1', title: 'Publish: VPN guide' }),
    ] }
    apolloFinto.risposte['KBArticlePreview'] = { kbArticle: KB_ARTICLE }
  })

  it('is fetched only when opened, and shows the article as it will be published', async () => {
    const { user } = renderWithProviders(<ApprovalsPage />)
    const c = card('Publish: VPN guide')
    expect(within(c).getByText('KB article')).toBeInTheDocument()
    // An article is not a ticket: no ticket link.
    expect(within(c).queryByRole('link')).toBeNull()
    expect(apolloFinto.chiamata('KBArticlePreview')).toBeUndefined()

    await user.click(within(c).getByRole('button', { name: 'Article preview' }))
    expect(apolloFinto.chiamata('KBArticlePreview')).toEqual({ id: 'kb-1' })
    expect(await screen.findByRole('heading', { name: 'How to connect to the VPN' })).toBeInTheDocument()
    expect(screen.getByText('Networking')).toBeInTheDocument()
    expect(screen.getByText('by Anna Bianchi')).toBeInTheDocument()
    expect(screen.getByText(`updated ${formatDate('2026-09-01T09:00:00Z')}`)).toBeInTheDocument()
    expect(screen.getByText('vpn')).toBeInTheDocument()
    expect(screen.getByText('remote')).toBeInTheDocument()
    // The body is Markdown, rendered.
    expect(screen.getByRole('heading', { name: 'Steps', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('client').tagName).toBe('STRONG')
  })

  it('closes and reopens without fetching the article again', async () => {
    const { user } = renderWithProviders(<ApprovalsPage />)
    const toggle = screen.getByRole('button', { name: 'Article preview' })
    await user.click(toggle)
    expect(await screen.findByRole('heading', { name: 'How to connect to the VPN' })).toBeInTheDocument()
    await user.click(toggle)
    expect(screen.queryByRole('heading', { name: 'How to connect to the VPN' })).toBeNull()
    await user.click(toggle)
    expect(screen.getByRole('heading', { name: 'How to connect to the VPN' })).toBeInTheDocument()
    expect(apolloFinto.chiamate['KBArticlePreview']).toHaveLength(1)
  })

  it('an article with no tags and no update date shows neither', async () => {
    apolloFinto.risposte['KBArticlePreview'] = { kbArticle: { ...KB_ARTICLE, tags: undefined, updatedAt: undefined } }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(screen.getByRole('button', { name: 'Article preview' }))
    expect(await screen.findByText('by Anna Bianchi')).toBeInTheDocument()
    expect(screen.queryByText(/^updated /)).toBeNull()
    expect(screen.queryByText('vpn')).toBeNull()
  })

  it('says so when the article cannot be loaded', async () => {
    apolloFinto.erroriQuery['KBArticlePreview'] = new Error('gone')
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(screen.getByRole('button', { name: 'Article preview' }))
    expect(await screen.findByText('Error loading the article.')).toBeInTheDocument()
  })

  it('says it is loading while the article is on its way', async () => {
    held.lazy.add('KBArticlePreview')
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(screen.getByRole('button', { name: 'Article preview' }))
    expect(await screen.findByText('Loading...')).toBeInTheDocument()
  })
})

describe('All', () => {
  it('lists every request with its outcome; only a pending one can be cancelled, and nothing is decided here', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.risposte['AllApprovals'] = { approvalRequests: { total: 6, items: [
      approval({ id: 'p', title: 'Still open' }),
      approval({ id: 'ok', title: 'Went through', status: 'approved', resolutionNote: 'Fine by me' }),
      approval({ id: 'no', title: 'Turned down', status: 'rejected' }),
      approval({ id: 'late', title: 'Ran out of time', status: 'expired' }),
      approval({ id: 'gone', title: 'Withdrawn', status: 'cancelled' }),
      approval({ id: 'odd', title: 'Odd one', status: 'escalated' }),
    ] } }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    expect(apolloFinto.chiamata('AllApprovals')).toEqual({ page: 1, pageSize: 20, filters: undefined })

    expect(within(card('Still open')).getByText('Pending')).toBeInTheDocument()
    expect(within(card('Went through')).getByText('Approved')).toBeInTheDocument()
    expect(within(card('Went through')).getByText('Note: Fine by me')).toBeInTheDocument()
    expect(within(card('Turned down')).getByText('Rejected')).toBeInTheDocument()
    expect(within(card('Ran out of time')).getByText('Expired')).toBeInTheDocument()
    expect(within(card('Withdrawn')).getByText('Cancelled')).toBeInTheDocument()
    // A state the page does not know is shown as it is, and reported.
    expect(within(card('Odd one')).getByText('escalated')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalledWith('[STATUS_COLORS] unknown value: "escalated"')

    expect(screen.getAllByRole('button', { name: 'Cancel the request' })).toHaveLength(1)
    expect(within(card('Still open')).getByRole('button', { name: 'Cancel the request' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('cancelling a request asks first: declining sends nothing, confirming cancels it', async () => {
    apolloFinto.risposte['AllApprovals'] = { approvalRequests: { total: 1, items: [approval()] } }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    await user.click(screen.getByRole('button', { name: 'Cancel the request' }))
    let dialog = screen.getByRole('dialog', { name: 'Cancel this approval request?' })
    expect(within(dialog).getByText('Upgrade the core switch')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Keep the request' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamata('CancelApprovalRequest')).toBeUndefined()

    await user.click(screen.getByRole('button', { name: 'Cancel the request' }))
    dialog = screen.getByRole('dialog', { name: 'Cancel this approval request?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel the request' }))
    await waitFor(() => expect(apolloFinto.chiamata('CancelApprovalRequest')).toEqual({ id: 'a1' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Request cancelled'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  /*
   * The confirmation read «Delete», the default of a destructive one, though
   * nothing is deleted (tour of 23 Sep 2026); and a plain «Cancel» beside
   * «Cancel the request» would not say which of the two keeps it.
   */
  it('the confirmation\'s buttons say what they do: keep the request, or cancel it — none reads «Delete»', async () => {
    apolloFinto.risposte['AllApprovals'] = { approvalRequests: { total: 1, items: [approval()] } }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    await user.click(screen.getByRole('button', { name: 'Cancel the request' }))
    const dialog = screen.getByRole('dialog', { name: 'Cancel this approval request?' })
    expect(within(dialog).getByRole('button', { name: 'Keep the request' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel the request' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('a cancellation the API refuses shows its message', async () => {
    apolloFinto.risposte['AllApprovals'] = { approvalRequests: { total: 1, items: [approval()] } }
    apolloFinto.esiti['CancelApprovalRequest'] = { error: new Error('Only the requester can cancel') }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    await user.click(screen.getByRole('button', { name: 'Cancel the request' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel the request' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only the requester can cancel'))
  })

  it('pages through the requests twenty at a time', async () => {
    apolloFinto.risposte['AllApprovals'] = { approvalRequests: { total: 45, items: [approval()] } }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(apolloFinto.chiamata('AllApprovals')).toMatchObject({ page: 2, pageSize: 20 })
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(apolloFinto.chiamata('AllApprovals')).toMatchObject({ page: 1 })
  })

  it('a filter is applied on the server and starts again from the first page', async () => {
    apolloFinto.risposte['AllApprovals'] = { approvalRequests: { total: 45, items: [approval()] } }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'status')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Value of condition 1' }), 'approved')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const vars = apolloFinto.chiamata('AllApprovals') as { page: number; filters: string }
    expect(vars.page).toBe(1)
    expect(JSON.parse(vars.filters).rules).toEqual([expect.objectContaining({ field: 'status', operator: 'equals', value: 'approved' })])
  })

  it('the type filter offers every kind of approval the product creates, with the customer names (F-40)', async () => {
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field of condition 1' }), 'entityType')
    const values = within(screen.getByRole('combobox', { name: 'Value of condition 1' })).getAllByRole('option').map((o) => o.textContent)
    expect(values).toEqual(['Select', 'Change', 'KB article', 'Disruption', 'Problem', 'Service Request'])
  })

  it('an empty register says so', async () => {
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    expect(screen.getByText('No requests found')).toBeInTheDocument()
  })

  it('a register that fails to load shows the error, and Retry reloads it', async () => {
    apolloFinto.erroriQuery['AllApprovals'] = new Error('register unavailable')
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    expect(screen.getByText('register unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No requests found')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('while the register loads the page says it is loading', async () => {
    held.queries.add('AllApprovals')
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('going back to my approvals asks for them again', async () => {
    apolloFinto.risposte['MyPendingApprovals'] = { myPendingApprovals: [approval({ title: 'Mine to decide' })] }
    const { user } = renderWithProviders(<ApprovalsPage />)
    await user.click(allTab())
    expect(screen.queryByText('Mine to decide')).toBeNull()
    await user.click(mineTab())
    expect(screen.getByText('Mine to decide')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Advanced filters/ })).toBeNull()
  })
})
