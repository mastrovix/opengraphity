/**
 * THE IMPROVEMENT PROPOSALS PAGE: READING AND DECIDING.
 *
 * The product proposes, a person decides. What breaks for that person if the
 * page regresses:
 *  - the three empty states say three different things ("never ran", "ran and
 *    all is well", "nothing decided yet"): mixing them makes a silent product
 *    look like a healthy one;
 *  - the evidence counts what the reader cannot see instead of hiding it;
 *  - each decision sends exactly what was chosen (a rejection with its kind
 *    and a real note, a Problem with the impact and urgency the person picked,
 *    never a default we invented), and a failed decision says so;
 *  - the history says who decided, when and why — a rejection is a decision
 *    and has to be re-readable;
 *  - without the permission, no decision buttons at all (the API would refuse).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
const perms = vi.hoisted(() => ({ list: ['proposal.accept', 'proposal.run'] as string[] }))
vi.mock('@/hooks/useMe', () => ({ useMe: () => ({ can: (...p: string[]) => p.some((x) => perms.list.includes(x)) }) }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({
    entriesOf: (name: string) => name === 'impact'
      ? [{ value: 'high', label: 'High impact' }, { value: 'low', label: null }]
      : name === 'urgency' ? [{ value: 'urgent', label: 'Urgent' }] : null,
  }),
}))

const { ProposalsPage } = await import('../ProposalsPage')

const param = (name: string, value: string) => ({ name, value })

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'p-1', area: 'daily_work', kind: 'proposal.dailyWorkSlowStep',
  params: [param('step', 'Approval'), param('median', '29.12'), param('p90', '40'), param('count', '12')],
  evidence: { n: 12, windowDays: 30, hiddenRefs: 0, refs: [], extra: [] },
  occurrences: 12, windowDays: 30, actionType: null, rationale: null, rationaleLanguage: null,
  status: 'open', createdAt: '2026-09-20T10:00:00Z',
  decidedAt: null, decidedBy: null, decidedByName: null, rejectedKind: null, rejectedNote: null, notNowUntil: null,
  auditEntryId: null, executionError: null, undoable: false, acknowledgeable: false, problemOpenable: false,
  openedProblemId: null, openedProblemNumber: null,
  verification: null, verifiedAt: null, verificationDetail: [], ...over,
})

const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ proposals: {
  total: items.length, maxOpen: 5, lastRunAt: '2026-09-20T02:00:00Z', aiAvailable: true,
  counts: { open: 3, accepted: 4, rejected: 2, notNow: 0, expired: 1, superseded: 0 },
  items, ...over,
} })

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  perms.list = ['proposal.accept', 'proposal.run']
})
afterEach(() => { vi.useRealTimers() })

const mount = () => renderWithProviders(<ProposalsPage />)
const card = (title: RegExp) => screen.getByText(title).closest('div[style*="border-radius: 10px"]') as HTMLElement

describe('ProposalsPage: the page around the proposals', () => {
  it('shows the counts, asks for the open ones first, and warns when there is no AI key', () => {
    apolloFinto.risposte['GetProposals'] = page([], { aiAvailable: false })
    mount()
    expect(apolloFinto.chiamata('GetProposals')).toEqual({ status: ['open', 'not_now'], limit: 50, offset: 0 })
    expect(screen.getByText('of 5 at most')).toBeInTheDocument()
    expect(screen.getByText(/The platform has no Anthropic key/)).toBeInTheDocument()
  })

  it('a query error is shown with a retry', async () => {
    apolloFinto.erroriQuery['GetProposals'] = new Error('server down')
    const { user } = mount()
    expect(screen.getByText(/server down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('never ran vs. ran and found nothing are two different messages', () => {
    apolloFinto.risposte['GetProposals'] = page([], { lastRunAt: null })
    const { unmount } = mount()
    expect(screen.getByText('The analysis has never run')).toBeInTheDocument()
    unmount()
    apolloFinto.risposte['GetProposals'] = page([])
    mount()
    expect(screen.getByText('Nothing to propose')).toBeInTheDocument()
    expect(screen.getByText(/The last analysis ran on 20 Sept 2026/)).toBeInTheDocument()
  })

  it('the decided tab reads the decided statuses and has its own empty message', async () => {
    apolloFinto.risposte['GetProposals'] = page([])
    const { user } = mount()
    await user.click(screen.getByRole('tab', { name: 'Already decided' }))
    expect(screen.getByRole('tab', { name: 'Already decided' })).toHaveAttribute('aria-selected', 'true')
    expect(apolloFinto.chiamata('GetProposals')).toMatchObject({ status: ['accepted', 'rejected', 'expired', 'superseded'] })
    expect(screen.getByText('No proposal has been decided yet.')).toBeInTheDocument()
  })
})

describe('ProposalsPage: running the analysis', () => {
  it('reports what the run produced AND what it dropped, as a success', async () => {
    apolloFinto.risposte['GetProposals'] = page([])
    apolloFinto.esiti['RunProposalAnalysis'] = { data: { runProposalAnalysis: { created: 2, skipped: [param('tetto_giornaliero', '2')] } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Analyse now' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      "2 new proposals · The model produced 2, and none reached this page: 2 over today's cap."))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('an empty answer says there was nothing new', async () => {
    apolloFinto.risposte['GetProposals'] = page([])
    apolloFinto.esiti['RunProposalAnalysis'] = { data: {} }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Analyse now' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Nothing new to propose.'))
    // The outcome stays on the page, next to the button (G44): a notice may not be seen.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Analysis run at \d{2}:\d{2}: Nothing new to propose\.$/))
  })

  // Tour of 23 Sep 2026: a reload that failed after a run that worked was
  // reported as «the run failed», and the run's result was never shown.
  it('a run that worked is reported even when the list cannot be reloaded', async () => {
    apolloFinto.risposte['GetProposals'] = page([])
    apolloFinto.esiti['RunProposalAnalysis'] = { data: {} }
    apolloFinto.refetch.mockRejectedValueOnce(new Error('network down'))
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Analyse now' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Nothing new to propose.'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'))
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/run/i))
  })

  it('a failed run is an error, not a success', async () => {
    apolloFinto.risposte['GetProposals'] = page([])
    apolloFinto.esiti['RunProposalAnalysis'] = { error: new Error('model unavailable') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Analyse now' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('without the permissions there is no run button and no decision button', () => {
    perms.list = []
    apolloFinto.risposte['GetProposals'] = page([proposal({ actionType: 'x', acknowledgeable: true })])
    mount()
    expect(screen.queryByRole('button', { name: 'Analyse now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })
})

describe('ProposalsPage: one proposal', () => {
  it('builds the title from kind and params, with numbers formatted by the reader\'s language', () => {
    apolloFinto.risposte['GetProposals'] = page([proposal()])
    mount()
    expect(screen.getByText('In step “Approval” tickets sit for 29.12 h (p90 40 h) over 12 runs')).toBeInTheDocument()
    expect(screen.getByText(/Daily work · 20 Sept 2026 · over 30 days/)).toBeInTheDocument()
    expect(screen.getByText('12 cases')).toBeInTheDocument()
  })

  it('shows the rationale with its language when it differs, the visible evidence and counts the hidden', () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({
      windowDays: 0, rationale: 'Scritto dal modello', rationaleLanguage: 'it',
      evidence: { n: 3, windowDays: 30, hiddenRefs: 2, extra: [], refs: [
        { entityType: 'incident', id: 'i-1', label: 'INC0001', visible: true },
        { entityType: 'incident', id: 'i-2', label: null, visible: true },
        { entityType: 'incident', id: 'i-3', label: 'SECRET', visible: false },
      ] },
      openedProblemId: 'pb-9', openedProblemNumber: 'PRB0009', executionError: 'timeout',
    })])
    mount()
    expect(screen.getByText(/written in it/)).toBeInTheDocument()
    expect(screen.getByText(/INC0001, i-2/)).toBeInTheDocument()
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument()
    expect(screen.getByText(/· 2 not visible with your permissions/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Problem opened: PRB0009' })).toHaveAttribute('href', '/problems/pb-9')
    expect(screen.getByText('The action failed: timeout')).toBeInTheDocument()
    expect(screen.queryByText(/over 0 days/)).not.toBeInTheDocument()
  })

  it('only hidden evidence has no leading separator; same-language rationale has no language note', () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({
      rationale: 'Written by the model', rationaleLanguage: 'en',
      evidence: { n: 1, windowDays: 30, hiddenRefs: 1, extra: [], refs: [{ entityType: 'incident', id: 'i-3', label: 'X', visible: false }] },
      openedProblemId: null, openedProblemNumber: 'PRB0010',
    })])
    mount()
    expect(screen.getByText('1 not visible with your permissions')).toBeInTheDocument()
    expect(screen.queryByText(/written in/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Problem opened: PRB0010' })).toHaveAttribute('href', '/problems/')
  })
})

describe('ProposalsPage: deciding', () => {
  it('accept, noted and not-now send the proposal id and reread the list', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'))
    apolloFinto.risposte['GetProposals'] = page([proposal({ actionType: 'remove_values', acknowledgeable: true })])
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(apolloFinto.chiamata('AcceptProposal')).toEqual({ id: 'p-1' }))
    await user.click(screen.getByRole('button', { name: 'Noted' }))
    await waitFor(() => expect(apolloFinto.chiamata('AcknowledgeProposal')).toEqual({ id: 'p-1' }))
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    // "Not now" means a week: after that the proposal comes back.
    await waitFor(() => expect(apolloFinto.chiamata('PostponeProposal')).toEqual({ id: 'p-1', until: '2026-09-29T12:00:00.000Z' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(3)
  })

  it('a postponed proposal cannot be postponed again, and has no accept without an action', () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({ status: 'not_now' })])
    mount()
    expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })

  // Tour of 23 Sep 2026: the same, for a decision.
  it('a decision that worked is not called a failure when the list cannot be reloaded', async () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({ actionType: 'x' })])
    apolloFinto.refetch.mockRejectedValueOnce(new Error('network down'))
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'))
    expect(toast.error).not.toHaveBeenCalledWith('That did not work.')
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled()
  })

  it('a failed decision says so and frees the buttons again', async () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({ actionType: 'x' })])
    apolloFinto.esiti['AcceptProposal'] = { error: new Error('refused') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('a rejection needs a real note (ten characters) and sends the chosen kind', async () => {
    apolloFinto.risposte['GetProposals'] = page([proposal()])
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Why are you rejecting it?' })
    // The default kind is "wrong analysis": the one that teaches the product it was noise.
    expect(within(dialog).getByRole('radio', { name: /The analysis is wrong/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(dialog).getByRole('radio', { name: /Fair, but we will not do it/ }))
    const confirm = within(dialog).getByRole('button', { name: 'Reject' })
    await user.type(within(dialog).getByLabelText('Note'), '  too short')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Note'), ' but now long enough  ')
    await user.click(confirm)
    await waitFor(() => expect(apolloFinto.chiamata('RejectProposal')).toEqual({
      id: 'p-1', kind: 'valid_but_declined', note: 'too short but now long enough',
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cancelling a rejection sends nothing', async () => {
    apolloFinto.risposte['GetProposals'] = page([proposal()])
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['RejectProposal']).toBeUndefined()
  })

  it('opening a Problem needs impact AND urgency chosen by the person — nothing preselected', async () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({ problemOpenable: true })])
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Open a Problem' }))
    const dialog = screen.getByRole('dialog', { name: 'Open a Problem from this proposal' })
    const open = within(dialog).getByRole('button', { name: 'Open a Problem' })
    expect(within(dialog).getByLabelText('Impact')).toHaveValue('')
    expect(open).toBeDisabled()
    // A value without a label is shown by its name.
    expect(within(dialog).getByRole('option', { name: 'low' })).toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText('Impact'), 'high')
    expect(open).toBeDisabled()
    await user.selectOptions(within(dialog).getByLabelText('Urgency'), 'urgent')
    await user.click(open)
    await waitFor(() => expect(apolloFinto.chiamata('OpenProblemFromProposal')).toEqual({ id: 'p-1', impact: 'high', urgency: 'urgent' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cancelling the Problem dialog sends nothing', async () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({ problemOpenable: true })])
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Open a Problem' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['OpenProblemFromProposal']).toBeUndefined()
  })
})

describe('ProposalsPage: the history', () => {
  it('says who decided, when and why, and offers undo where the server allows it', async () => {
    apolloFinto.risposte['GetProposals'] = page([
      proposal({ id: 'p-r', status: 'rejected', decidedAt: '2026-09-21T09:00:00Z', decidedByName: 'Anna',
        rejectedKind: 'wrong_analysis', rejectedNote: 'Seasonal peak' }),
      proposal({ id: 'p-a', kind: 'proposal.configMissingLabels', params: [param('count', '2'), param('vocabulary', 'impact'), param('values', 'a, b')],
        status: 'accepted', decidedAt: '2026-09-21T09:00:00Z', decidedByName: null, undoable: true }),
      proposal({ id: 'p-x', kind: 'proposal.portalSeveritiesStale', params: [param('count', '1'), param('values', 'z')],
        status: 'rejected', decidedAt: '2026-09-21T09:00:00Z', decidedByName: 'Bo', rejectedKind: 'valid_but_declined' }),
    ])
    const { user } = mount()
    await user.click(screen.getByRole('tab', { name: 'Already decided' }))
    expect(screen.getByText(/Rejected by Anna on 21 Sept 2026 — The analysis is wrong: «Seasonal peak»/)).toBeInTheDocument()
    // Decided by the product itself (no person): it says so.
    expect(screen.getByText('Accepted by the product on 21 Sept 2026')).toBeInTheDocument()
    expect(screen.getByText(/Rejected by Bo on 21 Sept 2026 — Fair, but we will not do it$/)).toBeInTheDocument()
    // No decision buttons in the history, only undo where allowed.
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    const undo = screen.getAllByRole('button', { name: 'Undo' })
    expect(undo).toHaveLength(1)
    await user.click(undo[0]!)
    await waitFor(() => expect(apolloFinto.chiamata('UndoProposal')).toEqual({ id: 'p-a' }))
    expect(card(/Write the 2 labels/)).toContainElement(undo[0]!)
  })
})

describe('ProposalsPage: the dialogs close from their header too', () => {
  it('closing either dialog with its close button sends nothing', async () => {
    apolloFinto.risposte['GetProposals'] = page([proposal({ problemOpenable: true })])
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Open a Problem' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['RejectProposal']).toBeUndefined()
    expect(apolloFinto.chiamate['OpenProblemFromProposal']).toBeUndefined()
  })
})

// ── The running of a tenant: a remedy is checked after it ran (26 Sep 2026) ──

describe('ProposalsPage — operational remedies', () => {
  const remedy = (over: Record<string, unknown>) => proposal({
    area: 'operations', kind: 'proposal.operationsFailedJobs',
    params: [param('queue', 'notifications'), param('count', '37')],
    actionType: 'queue.retry_failed', status: 'accepted', decidedAt: '2026-09-26T08:00:00Z', ...over,
  })

  it('the area is named, and the remedy says what it will do', async () => {
    apolloFinto.risposte['GetProposals'] = page([remedy({ status: 'open', decidedAt: null })])
    mount()
    expect(await screen.findByText('37 failed jobs in the notifications queue: retry them (twenty at most)')).toBeInTheDocument()
    expect(screen.getByText(/^Running ·/)).toBeInTheDocument()
    // Not accepted yet: no verification line.
    expect(screen.queryByText(/Remedy applied/)).toBeNull()
  })

  it('accepted and not checked yet: it says it will be checked', async () => {
    apolloFinto.risposte['GetProposals'] = page([remedy({})])
    mount()
    expect(await screen.findByText('Remedy applied: it is checked again a few minutes after running.')).toBeInTheDocument()
  })

  it('checked: held, with what was seen; or not held, and a person has to look', async () => {
    apolloFinto.risposte['GetProposals'] = page([
      remedy({ id: 'p-ok', verification: 'resolved', verifiedAt: '2026-09-26T08:05:00Z', verificationDetail: [param('retried', '20'), param('failedAgain', '0')] }),
      remedy({ id: 'p-ko', verification: 'unresolved', verifiedAt: '2026-09-26T08:05:00Z', verificationDetail: [param('retried', '20'), param('failedAgain', '3')] }),
    ])
    mount()
    expect(await screen.findByText(/the remedy held\. 20 jobs retried, 0 failed again\./)).toBeInTheDocument()
    expect(screen.getByText(/the remedy did not hold\. .*a person has to look\. 20 jobs retried, 3 failed again\./)).toBeInTheDocument()
  })

  it('each remedy of the graph says what the check found; the map\'s says only whether it held', async () => {
    apolloFinto.risposte['GetProposals'] = page([
      remedy({ id: 'p-a', kind: 'proposal.operationsStuckAlarms', params: [param('count', '3')], actionType: 'events.reevaluate_stuck',
        verification: 'unresolved', verifiedAt: '2026-09-26T08:05:00Z', verificationDetail: [param('alarms', '3'), param('stillStuck', '1')] }),
      remedy({ id: 'p-w', kind: 'proposal.operationsStuckWorkflows', params: [param('count', '2')], actionType: 'workflow.resume_automatic',
        verification: 'resolved', verifiedAt: '2026-09-26T08:05:00Z', verificationDetail: [param('tickets', '2'), param('stillStuck', '0')] }),
      remedy({ id: 'p-m', kind: 'proposal.operationsStaleServiceMap', params: [param('map', 'Billing')], actionType: 'service_map.sync',
        verification: 'resolved', verifiedAt: '2026-09-26T08:05:00Z', verificationDetail: [param('stale', 'false'), param('reason', '')] }),
    ])
    mount()
    expect(await screen.findByText(/did not hold\. .* 3 alarms re-evaluated, 1 still stuck\./)).toBeInTheDocument()
    expect(screen.getByText(/the remedy held\. 2 tickets resumed, 0 still on the step they were stuck on\./)).toBeInTheDocument()
    expect(screen.getByText('The service map “Billing” is behind the CMDB: synchronize it now')).toBeInTheDocument()
    expect(screen.getAllByText(/^Checked on .*: the remedy held\.$/)).toHaveLength(1)
  })
})
