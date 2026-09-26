/**
 * THE DETAIL OF A PROBLEM.
 *
 * Where a problem is investigated: it is assigned to a team and a person, its
 * root cause and workaround are written, it is linked to the incidents it
 * explains and the changes that fix it, and it moves along its workflow — one
 * of whose steps is not a plain transition but "request a change". The cards
 * with their own data and tests (CI list, linked tickets, comments, timeline,
 * chat, OLA, attachments…) are stubbed; what is pinned is what the PAGE
 * decides:
 *  - the step whose PURPOSE is `change_requested` opens a new change for this
 *    problem instead of moving it (a renamed step must still do so);
 *  - a transition that needs a note asks for at least ten characters, and one
 *    whose step actions partly failed says which;
 *  - team first, then a person OF THAT TEAM; an assignee can be removed;
 *  - the free-text fields are saved when left, and only if they changed;
 *  - the investigation dossier appears only when there is one, and copies;
 *  - delete only with its permission and after a confirmation;
 *  - loading, a failed read and a missing problem each say what they are.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ConfirmProvider } from '@/hooks/useConfirm'
import { renderWithProviders, attendiURL, LocationSpy } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'

const hoisted = vi.hoisted(() => ({
  loading: new Set<string>(),
  /** Mutations still running. */
  busy: new Set<string>(),
  downloadPdf: vi.fn(),
  slaSettling: vi.fn(),
  keycloak: { subject: 'kc-user-1' as string | undefined },
}))

vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const fake = moduloApollo()
  return {
    ...fake,
    // The first read of a query can be made to be still in flight; polling is
    // what the SLA settling asks for, and the fake has none of its own.
    useQuery: (doc: Parameters<typeof nomeOperazione>[0], opts?: Parameters<typeof fake.useQuery>[1]) => {
      const r = { ...fake.useQuery(doc, opts), startPolling: vi.fn(), stopPolling: vi.fn() }
      return hoisted.loading.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
    useMutation: (doc: Parameters<typeof nomeOperazione>[0], opts?: Parameters<typeof fake.useMutation>[1]) => {
      const [mutate, result] = fake.useMutation(doc, opts)
      return [mutate, { ...result, loading: hoisted.busy.has(nomeOperazione(doc)) }]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
vi.mock('@/lib/downloadPdf', () => ({ downloadPdf: hoisted.downloadPdf }))
vi.mock('@/hooks/useSlaSettling', () => ({ useSlaSettling: hoisted.slaSettling }))
vi.mock('@/lib/keycloak', async () => {
  const m = await import('@/test/mocks/keycloak')
  return { keycloak: hoisted.keycloak, getKeycloak: () => m.mockKeycloak, initKeycloak: vi.fn(async () => true), getTenantSlug: () => 'test-tenant' }
})

// Cards with their own data and tests: here they only show what the page gives them.
vi.mock('@/components/ticket/ola/TicketOLACard', () => ({ TicketOLACard: () => null }))
vi.mock('@/components/WatcherBar', () => ({ WatcherBar: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('@/components/ticket/TicketTasksSection', () => ({ TicketTasksSection: () => null }))
vi.mock('@/components/InternalChatPanel', () => ({
  InternalChatPanel: ({ entityType, entityId, currentUserId }: { entityType: string; entityId: string; currentUserId: string }) => (
    <p>{`internal chat on ${entityType} ${entityId} as "${currentUserId}"`}</p>
  ),
}))
vi.mock('@/components/ticket/customFields/CustomFieldsCard', () => ({
  CustomFieldsCard: ({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) => (
    <button type="button" onClick={onSaved}>{canEdit ? 'custom fields editable' : 'custom fields read-only'}</button>
  ),
}))
vi.mock('@/components/ticket/AffectedCIList', () => ({
  AffectedCIList: ({ ciResults, excludedTypes, onSearchChange, onAddCI, onRemoveCI }: {
    ciResults: Array<{ id: string; name: string }>; excludedTypes: readonly string[]
    onSearchChange: (s: string) => void; onAddCI: (id: string) => void; onRemoveCI: (id: string) => void
  }) => (
    <div data-testid="ci-list" data-excluded={excludedTypes.join(',')}>
      <button type="button" onClick={() => onSearchChange('db')}>search db</button>
      {ciResults.map((c) => <button type="button" key={c.id} onClick={() => onAddCI(c.id)}>{`add ${c.name}`}</button>)}
      <button type="button" onClick={() => onRemoveCI('ci-old')}>remove old</button>
    </div>
  ),
}))
vi.mock('@/components/UnifiedLinkedTickets', () => ({
  UnifiedLinkedTickets: ({ excludeId, types }: { excludeId?: string; types: Array<{ kind: string; label: string; items: Array<{ number: string }>; onLink: (id: string) => void; onUnlink: (id: string) => void }> }) => (
    <section aria-label={`linked tickets without ${excludeId}`}>
      {types.map((ty) => (
        <div key={ty.kind}>
          <span>{`${ty.label}: ${ty.items.map((i) => i.number).join(', ')}`}</span>
          <button type="button" onClick={() => ty.onLink(`${ty.kind.toLowerCase()}-new`)}>{`link ${ty.kind}`}</button>
          <button type="button" onClick={() => ty.onUnlink(`${ty.kind.toLowerCase()}-old`)}>{`unlink ${ty.kind}`}</button>
        </div>
      ))}
    </section>
  ),
}))
vi.mock('@/components/ticket/CommentsSection', () => ({
  CommentsSection: ({ comments, adding, onAdd, onChanged }: { comments: unknown[]; adding: boolean; onAdd: (text: string, isInternal: boolean) => unknown; onChanged?: () => void }) => (
    <div>
      <span>{`comments: ${comments.length}${adding ? ' (sending)' : ''}`}</span>
      <button type="button" onClick={() => void onAdd('Pool exhausted at peak', true)}>add a comment</button>
      <button type="button" onClick={() => onChanged?.()}>a comment changed</button>
    </div>
  ),
}))
vi.mock('@/components/ticket/WorkflowTimeline', () => ({
  WorkflowTimeline: ({ historyDesc, timelineOpen, onToggle }: { historyDesc: Array<{ stepName: string }>; timelineOpen: boolean; onToggle: () => void }) => (
    <button type="button" onClick={onToggle}>{`timeline ${timelineOpen ? 'open' : 'closed'}: ${historyDesc.map((h) => h.stepName).join(' < ')}`}</button>
  ),
}))

const { ProblemDetailPage } = await import('./ProblemDetailPage')

const wfStep = (name: string, label: string, order: number, over: Record<string, unknown> = {}) => ({
  id: `s-${name}`, name, label, labels: [], type: 'standard', isInitial: order === 1, isTerminal: false, isOpen: true,
  category: 'active', purpose: null, order, ...over,
})

const tr = (toStep: string, label: string, requiresInput = false, inputField: string | null = null) =>
  ({ toStep, label, labels: [], requiresInput, inputField, condition: null })

const history = (id: string, stepName: string) =>
  ({ id, stepName, enteredAt: '2026-09-14T08:00:00Z', exitedAt: null, durationMs: null, triggeredBy: 'u', triggerType: 'manual', notes: null })

const problem = (over: Record<string, unknown> = {}) => ({
  id: 'prb-1', number: 'PRB00000007', title: 'Checkout times out', description: 'Timeouts under load',
  priority: 'critical', category: 'database', status: 'under_investigation',
  rootCause: null, workaround: 'Restart the pool', affectedUsers: 10,
  createdAt: '2026-09-14T08:00:00Z', updatedAt: '2026-09-23T10:00:00Z', resolvedAt: null,
  slaStatus: null, createdBy: { id: 'u-c', name: 'Carla Creator' },
  assignee: null, assignedTeam: { id: 't-dba', name: 'DBA' },
  affectedCIs: [],
  linkedIncidents: [{ id: 'inc-1', number: 'INC00000011', title: 'Checkout down', status: 'resolved' }],
  linkedProblems: [], linkedChanges: [{ id: 'chg-1', number: 'CHG00000002', title: 'Pool size', status: 'closed' }],
  workflowInstance: { id: 'wi-1', currentStep: 'under_investigation', status: 'running' },
  availableTransitions: [
    tr('known_error', 'Mark as known error'),
    tr('waiting_change', 'Request a change'),
    tr('rejected', 'Reject', true, 'rejection_reason'),
  ],
  workflowHistory: [history('h1', 'new'), history('h2', 'under_investigation')],
  comments: [{ id: 'c1' }],
  customFields: [],
  ...over,
})

let permissions: string[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
  apolloFinto.reset()
  hoisted.loading.clear()
  hoisted.busy.clear()
  hoisted.downloadPdf.mockReset().mockResolvedValue(undefined)
  hoisted.slaSettling.mockReset()
  hoisted.keycloak.subject = 'kc-user-1'
  toast.success.mockReset()
  toast.error.mockReset()
  toast.warning.mockReset()
  permissions = ['ticket.work', 'problem.write', 'problem.delete']
  apolloFinto.risposte['GetMe'] = () => ({ me: { id: 'u-me', name: 'Me', email: 'me@x', role: 'custom', roleName: null, permissions, teams: [] } })
  apolloFinto.risposte['GetProblem'] = { problem: problem() }
  apolloFinto.risposte['ProblemDossier'] = { problemDossier: null }
  apolloFinto.risposte['GetUsers'] = { users: [
    { id: 'u1', name: 'Dora DBA', email: 'dora@x', teams: [{ id: 't-dba', name: 'DBA' }] },
    { id: 'u2', name: 'Nick Network', email: 'nick@x', teams: [{ id: 't-net', name: 'Network' }] },
    { id: 'u3', name: 'Tess Teamless', email: 'tess@x', teams: null },
  ] }
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'problem', ciTypes: ['person'] }] }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [{ id: 'ci-db', name: 'orders-db', type: 'database', status: 'active', environment: 'production' }] } }
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [
    wfStep('new', 'New', 1),
    wfStep('under_investigation', 'Under investigation', 2),
    wfStep('known_error', 'Known error', 3, { category: 'waiting' }),
    wfStep('waiting_change', 'Waiting for the change', 4, { purpose: 'change_requested', category: 'waiting' }),
    wfStep('rejected', 'Rejected', 5, { isTerminal: true, isOpen: false, category: 'failed' }),
  ] } }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [
    { id: 'i', name: 'incident', label: 'Disruption', fields: [] },
    { id: 'p', name: 'problem', label: 'Problem', fields: [] },
    { id: 'c', name: 'change', label: 'Change', fields: [] },
  ] }
  apolloFinto.risposte['GetTeamChoices'] = { teams: [
    { id: 't-dba', name: 'DBA', type: 'support', isChangeManager: false },
    { id: 't-net', name: 'Network', type: 'support', isChangeManager: false },
  ] }
})

afterEach(() => { vi.useRealTimers() })

const LABELS = { priority: { critical: 'Critical' }, category: { database: 'Database' } }

/** The page, on a tab when given (it is in the address: ?tab=). */
const mount = (tab?: string) => renderWithProviders(withVocabularyLabels(<ProblemDetailPage />, LABELS), { route: tab ? `/problems/prb-1?tab=${tab}` : '/problems/prb-1', path: '/problems/:id' })

const setProblem = (over: Record<string, unknown>) => { apolloFinto.risposte['GetProblem'] = { problem: problem(over) } }

/** The value shown under a field label of the information card. */
const field = (label: string) => screen.getByText(label, { selector: 'div' }).parentElement!.nextElementSibling as HTMLElement

describe('ProblemDetailPage — when there is no problem to show', () => {
  it('while the problem loads it shows placeholders, not "not found"', () => {
    hoisted.loading.add('GetProblem')
    const { container } = mount()
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    expect(screen.queryByText('Problem not found.')).not.toBeInTheDocument()
  })

  it('a problem that cannot be read shows the error and a retry', async () => {
    apolloFinto.erroriQuery['GetProblem'] = new Error('problem unavailable')
    const { user } = mount()
    expect(screen.getByText('problem unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a problem that does not exist says so, and leads back to the list', async () => {
    apolloFinto.risposte['GetProblem'] = { problem: null }
    const { user } = mount()
    expect(screen.getByText(/Problem not found\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to list' }))
    await attendiURL('/problems')
  })
})

describe('ProblemDetailPage — the information card', () => {
  it('reads the problem by id and shows its facts with the customer labels', () => {
    mount()
    expect(apolloFinto.chiamata('GetProblem')).toEqual({ id: 'prb-1' })
    expect(screen.getByRole('heading', { level: 1, name: 'Checkout times out' })).toBeInTheDocument()
    expect(field('Ticket number')).toHaveTextContent('PRB00000007')
    expect(field('Description')).toHaveTextContent('Timeouts under load')
    expect(field('Priority')).toHaveTextContent('Critical')
    expect(within(field('Priority')).getByText('Critical')).toHaveAttribute('title', 'critical')
    expect(field('Category')).toHaveTextContent('Database')
    expect(field('SLA')).toHaveTextContent('No SLA')
    expect(field('Workflow step')).toHaveTextContent('Under investigation')
    expect(field('Created by')).toHaveTextContent('Carla Creator')
    expect(field('Created')).toHaveTextContent('14 Sept 2026')
    expect(field('Updated')).toHaveTextContent('2 hours ago')
    expect(screen.queryByText('Resolved', { selector: 'div' })).not.toBeInTheDocument()
  })

  it('what is missing reads as missing: no description, no category, no creator', () => {
    setProblem({ description: null, category: null, createdBy: null, updatedAt: null })
    mount()
    expect(field('Description')).toHaveTextContent('No description.')
    expect(field('Category')).toHaveTextContent('—')
    expect(screen.queryByText('Created by', { selector: 'div' })).not.toBeInTheDocument()
    expect(screen.queryByText('Updated', { selector: 'div' })).not.toBeInTheDocument()
  })

  it('a value without a customer label is shown as it is', () => {
    // The neutral style of a value outside the Dictionary is announced on the console: expected here.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setProblem({ priority: 'p9', category: 'storage', workflowInstance: null, status: 'legacy_state' })
    mount()
    expect(field('Priority')).toHaveTextContent('p9')
    expect(field('Category')).toHaveTextContent('storage')
    // Without a workflow instance the step is the status of the ticket.
    expect(field('Workflow step')).toHaveTextContent(/legacy.state/)
  })

  it('a resolved problem shows its SLA and resolution date, and keeps reading until its SLA settles', () => {
    const sla = { startedAt: '2026-09-14T08:00:00Z', responseDeadline: '2026-09-14T09:00:00Z', resolveDeadline: '2026-09-20T08:00:00Z',
      responseMet: true, resolveMet: true, breached: false, pausedAt: null, warningMinutes: 60 }
    setProblem({ slaStatus: sla, resolvedAt: '2026-09-19T08:00:00Z' })
    mount()
    expect(field('SLA')).toHaveTextContent('SLA met')
    expect(field('Resolved')).toHaveTextContent('19 Sept 2026')
    expect(hoisted.slaSettling).toHaveBeenLastCalledWith(sla, true, expect.objectContaining({ startPolling: expect.any(Function), stopPolling: expect.any(Function) }))
  })

  it('an open problem is not waiting for an SLA to settle', () => {
    mount()
    expect(hoisted.slaSettling).toHaveBeenLastCalledWith(null, false, expect.anything())
  })

  it('the affected users are saved when the field is left with a new number, and only then', async () => {
    apolloFinto.esiti['UpdateProblem'] = { data: { updateProblem: { id: 'prb-1' } } }
    const { user } = mount()
    const input = within(field('Affected users')).getByRole('spinbutton')
    expect(input).toHaveValue(10)
    await user.click(input)
    await user.tab()
    expect(apolloFinto.chiamata('UpdateProblem')).toBeUndefined()
    await user.clear(input)
    await user.type(input, '25')
    await user.tab()
    expect(apolloFinto.chiamata('UpdateProblem')).toEqual({ id: 'prb-1', input: { affectedUsers: 25 } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Updated'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    await user.type(input, '{Backspace}{Backspace}10')
    await user.tab()
    expect(apolloFinto.chiamate['UpdateProblem']).toHaveLength(1)
  })

  // Tour of 23 Sep 2026: an emptied field went out as `affectedUsers: NaN`
  // (null on the wire only by accident of JSON); now the unknown count is an
  // explicit null, which the API stores as such.
  it('emptying the count of affected users saves it as not known', async () => {
    const { user } = mount()
    const input = within(field('Affected users')).getByRole('spinbutton')
    await user.clear(input)
    await user.tab()
    expect(apolloFinto.chiamate['UpdateProblem']).toHaveLength(1)
    expect(apolloFinto.chiamata('UpdateProblem')).toStrictEqual({ id: 'prb-1', input: { affectedUsers: null } })
  })

  // Tour of 23 Sep 2026: with no count yet, typing a number and emptying the
  // field again saved it — NaN is never equal to the null already there.
  it('without a count, typing a number and emptying the field again saves nothing', async () => {
    setProblem({ affectedUsers: null })
    const { user } = mount()
    const input = within(field('Affected users')).getByRole('spinbutton')
    await user.type(input, '5')
    await user.clear(input)
    await user.tab()
    expect(apolloFinto.chiamata('UpdateProblem')).toBeUndefined()
  })

  // Tour of 23 Sep 2026: a number the browser cannot read («-») arrives as an
  // empty value, and leaving the field cleared the count.
  it('a count the browser cannot read as a number is not saved, and the reason is said', async () => {
    const { user } = mount()
    const input = within(field('Affected users')).getByRole('spinbutton')
    await user.clear(input)
    Object.defineProperty(input, 'validity', { configurable: true, value: { ...(input as HTMLInputElement).validity, badInput: true } })
    await user.tab()
    expect(apolloFinto.chiamata('UpdateProblem')).toBeUndefined()
    expect(toast.error).toHaveBeenCalledWith('The number of affected users is not a number: it was not saved.')
  })

  it('a problem with no workaround yet starts with an empty workaround', () => {
    setProblem({ workaround: null })
    mount('diagnosis')
    expect(screen.getByPlaceholderText('Describe the temporary workaround...')).toHaveValue('')
  })

  it('a problem with no count of affected users starts empty', () => {
    setProblem({ affectedUsers: null })
    mount()
    expect(within(field('Affected users')).getByRole('spinbutton')).toHaveValue(null)
  })

  it('root cause and workaround are saved when left, only if they changed; a refused save is reported', async () => {
    apolloFinto.esiti['UpdateProblem'] = { error: new Error('field locked') }
    // On the diagnosis tab both are open: no folded card to unfold first.
    const { user } = mount('diagnosis')
    const rootCause = screen.getByPlaceholderText('Describe the root cause of the problem...')
    expect(rootCause).toHaveValue('')
    await user.click(rootCause)
    await user.tab()
    expect(apolloFinto.chiamata('UpdateProblem')).toBeUndefined()
    await user.type(rootCause, 'Pool too small')
    // While written, the field says when it is saved (G23).
    expect(screen.getByRole('status')).toHaveTextContent('Not saved yet: it is saved when you leave the field.')
    await user.tab()
    expect(screen.queryByText('Not saved yet: it is saved when you leave the field.')).toBeNull()
    expect(apolloFinto.chiamata('UpdateProblem')).toEqual({ id: 'prb-1', input: { rootCause: 'Pool too small' } })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('field locked'))
    const workaround = screen.getByPlaceholderText('Describe the temporary workaround...')
    expect(workaround).toHaveValue('Restart the pool')
    await user.click(workaround)
    await user.tab()
    expect(apolloFinto.chiamate['UpdateProblem']).toHaveLength(1)
    await user.type(workaround, ' twice')
    await user.tab()
    expect(apolloFinto.chiamata('UpdateProblem')).toEqual({ id: 'prb-1', input: { workaround: 'Restart the pool twice' } })
  })

  it('the customer fields are editable with ticket.work, and a save reads the problem again', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'custom fields editable' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('without ticket.work the customer fields are read-only, and without problem.delete there is no Delete', () => {
    permissions = []
    mount()
    expect(screen.getByRole('button', { name: 'custom fields read-only' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
})

describe('ProblemDetailPage — team and person', () => {
  it('with a team, a person of THAT team can be assigned', async () => {
    apolloFinto.esiti['AssignProblemToUser'] = { data: { assignProblemToUser: { id: 'prb-1' } } }
    const { user } = mount()
    expect(field('Assigned team')).toHaveTextContent('DBA')
    const select = screen.getByRole('combobox', { name: 'Assignee' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select user…', 'Dora DBA'])
    const assign = within(field('Assigned to')).getByRole('button', { name: 'Assign' })
    expect(assign).toBeDisabled()
    await user.selectOptions(select, 'u1')
    await user.click(assign)
    expect(apolloFinto.chiamata('AssignProblemToUser')).toEqual({ problemId: 'prb-1', userId: 'u1' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('User assigned'))
    expect(select).toHaveValue('')
  })

  it('while an assignment runs, its button says so and cannot be pressed again', async () => {
    hoisted.busy.add('AssignProblemToUser')
    hoisted.busy.add('AssignProblemToTeam')
    const { user } = mount()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assignee' }), 'u1')
    expect(within(field('Assigned to')).getByRole('button', { name: 'Assigning…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.click(screen.getByRole('combobox', { name: 'Assigned team' }))
    await user.click(await screen.findByRole('option', { name: 'Network' }))
    expect(within(field('Assigned team')).getByRole('button', { name: 'Assigning…' })).toBeDisabled()
  })

  it('while an unassignment runs, it cannot be asked twice', () => {
    hoisted.busy.add('AssignProblemToUser')
    setProblem({ assignee: { id: 'u1', name: 'Dora DBA', email: 'dora@x' } })
    mount()
    expect(screen.getByRole('button', { name: 'Remove the assignment' })).toBeDisabled()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the page ignored whether
  // the people were still loading, and until GetUsers answered it stated "No
  // user in the DBA group." — a false claim about the team. It now says it is
  // loading, and a failed read says so (below).
  it('while the people are loading, the page does not claim that the team has nobody', () => {
    hoisted.loading.add('GetUsers')
    mount()
    expect(screen.queryByText('No user in the DBA group.')).not.toBeInTheDocument()
    expect(within(field('Assigned to')).getByText('Loading...')).toBeInTheDocument()
  })

  it('people that cannot be read are said to be unreadable, not absent', () => {
    apolloFinto.erroriQuery['GetUsers'] = new Error('directory unavailable')
    mount()
    expect(screen.queryByText('No user in the DBA group.')).not.toBeInTheDocument()
    expect(within(field('Assigned to')).getByText('The people of the DBA group could not be read: directory unavailable')).toBeInTheDocument()
  })

  it('a team with no people says so', () => {
    setProblem({ assignedTeam: { id: 't-empty', name: 'Night shift' } })
    mount()
    expect(screen.getByText('No user in the Night shift group.')).toBeInTheDocument()
  })

  it('without a team, the person waits for a team first', () => {
    setProblem({ assignedTeam: null })
    mount()
    expect(screen.getByText('Assign a group first, then you can pick a user.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).not.toBeInTheDocument()
  })

  it('an assigned person is shown and can be unassigned', async () => {
    setProblem({ assignee: { id: 'u1', name: 'Dora DBA', email: 'dora@x' } })
    const { user } = mount()
    expect(field('Assigned to')).toHaveTextContent('Dora DBAdora@x')
    await user.click(screen.getByRole('button', { name: 'Remove the assignment' }))
    expect(apolloFinto.chiamata('AssignProblemToUser')).toEqual({ problemId: 'prb-1', userId: null })
  })

  it('a refused assignment of a person is reported', async () => {
    apolloFinto.esiti['AssignProblemToUser'] = { error: new Error('not assignable') }
    const { user } = mount()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assignee' }), 'u1')
    await user.click(within(field('Assigned to')).getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not assignable'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('reassigning the team: pick a support team, assign, and the picker closes', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    const assign = within(field('Assigned team')).getByRole('button', { name: 'Assign' })
    expect(assign).toBeDisabled()
    await user.click(screen.getByRole('combobox', { name: 'Assigned team' }))
    await user.click(await screen.findByRole('option', { name: 'Network' }))
    await user.click(assign)
    expect(apolloFinto.chiamata('AssignProblemToTeam')).toEqual({ problemId: 'prb-1', teamId: 't-net' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Team assigned'))
    expect(screen.queryByRole('combobox', { name: 'Assigned team' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reassign' })).toBeInTheDocument()
  })

  it('Cancel leaves the team as it was', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reassign' }))
    await user.click(within(field('Assigned team')).getByRole('button', { name: 'Cancel' }))
    expect(field('Assigned team')).toHaveTextContent('DBAReassign')
    expect(apolloFinto.chiamata('AssignProblemToTeam')).toBeUndefined()
  })

  it('without a team the picker is there at once, with nothing to cancel; a refused assignment is reported', async () => {
    apolloFinto.esiti['AssignProblemToTeam'] = { error: new Error('team archived') }
    setProblem({ assignedTeam: null })
    const { user } = mount()
    expect(within(field('Assigned team')).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Assigned team' }))
    await user.click(await screen.findByRole('option', { name: 'DBA' }))
    await user.click(within(field('Assigned team')).getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('team archived'))
  })
})

describe('ProblemDetailPage — the workflow', () => {
  it('shows the transitions of the step, and the history newest first', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Mark as known error' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'timeline open: under_investigation < new' })).toBeInTheDocument()
  })

  it('the history can be folded and unfolded', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: /^timeline open/ }))
    expect(screen.getByRole('button', { name: /^timeline closed/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^timeline closed/ }))
    expect(screen.getByRole('button', { name: /^timeline open/ })).toBeInTheDocument()
  })

  it('a transition without input moves the problem, says so, and reads it again', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Mark as known error' }))
    expect(apolloFinto.chiamata('ExecuteProblemTransition')).toEqual({ problemId: 'prb-1', toStep: 'known_error' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Transition completed'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a step of purpose known_error asks for the cause and the workaround, saves them, then moves (G22)', async () => {
    const steps = (apolloFinto.risposte['GetWorkflowDefinition'] as { workflowDefinition: { steps: Array<{ name: string; purpose: string | null }> } }).workflowDefinition.steps
    apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: steps.map((st) => (st.name === 'known_error' ? { ...st, purpose: 'known_error' } : st)) } }
    apolloFinto.esiti['UpdateProblem'] = { data: { updateProblem: { id: 'prb-1' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Mark as known error' }))
    const dialog = screen.getByRole('dialog', { name: 'Transition → Known error' })
    const cause = within(dialog).getByLabelText('Root cause *')
    const workaround = within(dialog).getByLabelText('Workaround *')
    await user.clear(cause)
    await user.clear(workaround)
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled()
    expect(apolloFinto.chiamata('ExecuteProblemTransition')).toBeUndefined()
    await user.type(cause, 'The pool is too small')
    await user.type(workaround, 'Restart the pool')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(apolloFinto.chiamata('ExecuteProblemTransition')).toEqual({ problemId: 'prb-1', toStep: 'known_error' }))
    expect(apolloFinto.chiamata('UpdateProblem')).toEqual({ id: 'prb-1', input: { rootCause: 'The pool is too small', workaround: 'Restart the pool' } })
  })

  it('a transition whose step actions partly failed says which ones, instead of "completed"', async () => {
    apolloFinto.esiti['ExecuteProblemTransition'] = { data: { executeProblemTransition: { actionErrors: ['SLA timer'] } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Mark as known error' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Transition executed, but 1 action failed: SLA timer', { duration: 10000 }))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a refused transition is reported', async () => {
    apolloFinto.esiti['ExecuteProblemTransition'] = { error: new Error('root cause required') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Mark as known error' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('root cause required'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('the step whose purpose is "change requested" opens a new change for this problem, and moves nothing', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Request a change' }))
    await attendiURL('/changes/new', { problemId: 'prb-1' })
    expect(apolloFinto.chiamata('ExecuteProblemTransition')).toBeUndefined()
  })

  it('a transition that needs a note asks for at least ten characters, and sends it trimmed', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Transition → Rejected' })
    expect(dialog).toHaveTextContent('Add a note for this transition (at least 10 characters).')
    const note = within(dialog).getByPlaceholderText('Notes on the transition...')
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    await user.type(note, '   too short ')
    expect(confirm).toBeDisabled()
    await user.clear(note)
    await user.type(note, '  Duplicate of PRB00000003  ')
    await user.click(confirm)
    expect(apolloFinto.chiamata('ExecuteProblemTransition')).toEqual({ problemId: 'prb-1', toStep: 'rejected', notes: 'Duplicate of PRB00000003' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('while a transition runs, no other transition can start', () => {
    hoisted.busy.add('ExecuteProblemTransition')
    mount()
    expect(screen.getByRole('button', { name: 'Mark as known error' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
  })

  it('while a noted transition runs, its confirmation says so and cannot be pressed again', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const note = screen.getByPlaceholderText('Notes on the transition...')
    await user.type(note, 'Duplicate of PRB00000003')
    hoisted.busy.add('ExecuteProblemTransition')
    // The next render reads the transition as running.
    await user.type(note, '.')
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Running…' })).toBeDisabled()
  })

  it('the note dialog closes with Cancel or Escape, and a new one starts blank', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await user.type(screen.getByPlaceholderText('Notes on the transition...'), 'Half a thought')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.getByPlaceholderText('Notes on the transition...')).toHaveValue('')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('ExecuteProblemTransition')).toBeUndefined()
  })

  it('Back returns to where the user came from', async () => {
    const user = userEvent.setup()
    render(withVocabularyLabels(
      <MemoryRouter initialEntries={['/problems?q=pool', '/problems/prb-1']} initialIndex={1}>
        <ConfirmProvider>
          <Routes>
            <Route path="/problems/:id" element={<ProblemDetailPage />} />
            <Route path="*" element={<LocationSpy />} />
          </Routes>
        </ConfirmProvider>
      </MemoryRouter>,
      LABELS,
    ))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await attendiURL('/problems', { q: 'pool' })
  })
})

describe('ProblemDetailPage — header actions', () => {
  it('the PDF is downloaded as NUMBER.pdf; a failure says so', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    expect(hoisted.downloadPdf).toHaveBeenCalledWith('/api/problems/prb-1/pdf', 'PRB00000007.pdf')
    hoisted.downloadPdf.mockRejectedValue(new Error('500'))
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('PDF export failed'))
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled()
  })

  it('while the PDF downloads the button waits; a problem without number is saved under its id', async () => {
    let finish: () => void = () => {}
    hoisted.downloadPdf.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    setProblem({ number: '' })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    expect(hoisted.downloadPdf).toHaveBeenCalledWith('/api/problems/prb-1/pdf', 'prb-1.pdf')
    expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled()
    finish()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled())
  })

  it('Delete asks first, naming the problem; declining deletes nothing', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete problem PRB00000007 for good?' })
    expect(dialog).toHaveTextContent('This action cannot be undone.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('DeleteProblem')).toBeUndefined()
  })

  it('while the deletion runs, Delete cannot be pressed again', () => {
    hoisted.busy.add('DeleteProblem')
    mount()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('confirming the deletion deletes the problem and goes back to the list', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteProblem')).toEqual({ id: 'prb-1' }))
    expect(toast.success).toHaveBeenCalledWith('Problem deleted')
    await attendiURL('/problems')
  })

  it('a problem without number is named without one; a refused deletion is reported and the problem stays', async () => {
    apolloFinto.esiti['DeleteProblem'] = { error: new Error('linked to an open change') }
    setProblem({ number: '' })
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete problem for good?' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('linked to an open change'))
    await attendiURL('/problems/prb-1')
  })
})

describe('ProblemDetailPage — the investigation dossier', () => {
  const DOSSIER = 'Error signature: pool exhausted\nModules: api/db/pool.ts'

  it('exists only for problems that have one', () => {
    mount()
    expect(apolloFinto.chiamata('ProblemDossier')).toEqual({ problemId: 'prb-1' })
    expect(screen.queryByRole('button', { name: 'Investigation dossier' })).not.toBeInTheDocument()
  })

  it('opens to be read, copies whole, and closes', async () => {
    apolloFinto.risposte['ProblemDossier'] = { problemDossier: DOSSIER }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Investigation dossier' }))
    const dialog = screen.getByRole('dialog', { name: 'Investigation dossier' })
    expect(within(dialog).getByText(/Error signature: pool exhausted/)).toHaveTextContent('Modules: api/db/pool.ts')
    await user.click(within(dialog).getByRole('button', { name: 'Copy the dossier' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Dossier copied.'))
    expect(await navigator.clipboard.readText()).toBe(DOSSIER)
    // The Close of the footer (the header has its own ×).
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The header × closes it too.
    await user.click(screen.getByRole('button', { name: 'Investigation dossier' }))
    await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a copy that the browser refuses says to select it by hand', async () => {
    apolloFinto.risposte['ProblemDossier'] = { problemDossier: DOSSIER }
    const { user } = mount()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    await user.click(screen.getByRole('button', { name: 'Investigation dossier' }))
    await user.click(screen.getByRole('button', { name: 'Copy the dossier' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy: select it by hand.'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('ProblemDetailPage — CIs, linked tickets, comments and chat', () => {
  it('searches CIs without the excluded types, links one and removes another', async () => {
    const { user } = mount()
    expect(screen.getByTestId('ci-list')).toHaveAttribute('data-excluded', 'person')
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'search db' }))
    expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ search: 'db', limit: 20, excludeCiTypes: ['person'] })
    await user.click(screen.getByRole('button', { name: 'add orders-db' }))
    expect(apolloFinto.chiamata('AddCIToProblem')).toEqual({ problemId: 'prb-1', ciId: 'ci-db' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI added'))
    await user.click(screen.getByRole('button', { name: 'remove old' }))
    expect(apolloFinto.chiamata('RemoveCIFromProblem')).toEqual({ problemId: 'prb-1', ciId: 'ci-old' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI removed'))
  })

  it('while the excluded types are unknown nothing is searched', async () => {
    apolloFinto.risposte['GetTicketCIExclusions'] = undefined
    const { user } = mount()
    expect(screen.getByTestId('ci-list')).toHaveAttribute('data-excluded', '')
    await user.click(screen.getByRole('button', { name: 'search db' }))
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined()
  })

  it('a refused CI link or removal is reported', async () => {
    apolloFinto.esiti['AddCIToProblem'] = { error: new Error('excluded type') }
    apolloFinto.esiti['RemoveCIFromProblem'] = { error: new Error('not linked') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'search db' }))
    await user.click(screen.getByRole('button', { name: 'add orders-db' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('excluded type'))
    await user.click(screen.getByRole('button', { name: 'remove old' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not linked'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows the linked incidents, problems and changes under the customer names, never itself', () => {
    mount('links')
    const linked = screen.getByRole('region', { name: 'linked tickets without prb-1' })
    expect(within(linked).getByText('Disruption: INC00000011')).toBeInTheDocument()
    expect(within(linked).getByText('Problem:')).toBeInTheDocument()
    expect(within(linked).getByText('Change: CHG00000002')).toBeInTheDocument()
  })

  it('a problem without link lists gives the section empty lists', () => {
    setProblem({ linkedIncidents: undefined, linkedProblems: undefined, linkedChanges: undefined, customFields: undefined })
    mount('links')
    expect(screen.getByText('Disruption:')).toBeInTheDocument()
    expect(screen.getByText('Change:')).toBeInTheDocument()
  })

  it('links and unlinks incidents, related problems and resolving changes, each the right way', async () => {
    const { user } = mount('links')
    await user.click(screen.getByRole('button', { name: 'link INCIDENT' }))
    expect(apolloFinto.chiamata('LinkIncidentToProblem')).toEqual({ problemId: 'prb-1', incidentId: 'incident-new' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Incident linked'))
    await user.click(screen.getByRole('button', { name: 'unlink INCIDENT' }))
    expect(apolloFinto.chiamata('UnlinkIncidentFromProblem')).toEqual({ problemId: 'prb-1', incidentId: 'incident-old' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Incident unlinked'))
    await user.click(screen.getByRole('button', { name: 'link PROBLEM' }))
    expect(apolloFinto.chiamata('LinkRelatedTicket')).toEqual({ entityType: 'problem', entityId: 'prb-1', otherId: 'problem-new' })
    await user.click(screen.getByRole('button', { name: 'unlink PROBLEM' }))
    expect(apolloFinto.chiamata('UnlinkRelatedTicket')).toEqual({ entityType: 'problem', entityId: 'prb-1', otherId: 'problem-old' })
    // A change is linked as the one that RESOLVES the problem.
    await user.click(screen.getByRole('button', { name: 'link CHANGE' }))
    expect(apolloFinto.chiamata('LinkResolvedTicket')).toEqual({ changeId: 'change-new', entityType: 'problem', entityId: 'prb-1' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Change linked'))
    await user.click(screen.getByRole('button', { name: 'unlink CHANGE' }))
    expect(apolloFinto.chiamata('UnlinkResolvedTicket')).toEqual({ changeId: 'change-old', entityType: 'problem', entityId: 'prb-1' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused link or unlink is reported', async () => {
    for (const op of ['LinkIncidentToProblem', 'UnlinkIncidentFromProblem', 'LinkRelatedTicket', 'LinkResolvedTicket']) {
      apolloFinto.esiti[op] = { error: new Error(`${op} refused`) }
    }
    const { user } = mount('links')
    await user.click(screen.getByRole('button', { name: 'link INCIDENT' }))
    await user.click(screen.getByRole('button', { name: 'unlink INCIDENT' }))
    await user.click(screen.getByRole('button', { name: 'link PROBLEM' }))
    await user.click(screen.getByRole('button', { name: 'link CHANGE' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(4))
    expect(toast.error).toHaveBeenCalledWith('LinkRelatedTicket refused')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a comment is added to this problem with its visibility, and a changed comment reads the problem again', async () => {
    const { user } = mount()
    expect(screen.getByText('comments: 1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'add a comment' }))
    expect(apolloFinto.chiamata('AddProblemComment')).toEqual({ problemId: 'prb-1', text: 'Pool exhausted at peak', isInternal: true })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Comment added'))
    apolloFinto.refetch.mockClear()
    await user.click(screen.getByRole('button', { name: 'a comment changed' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('while a comment is being sent, the comments section knows it', () => {
    hoisted.busy.add('AddProblemComment')
    mount()
    expect(screen.getByText('comments: 1 (sending)')).toBeInTheDocument()
  })

  it('a refused comment is reported', async () => {
    apolloFinto.esiti['AddProblemComment'] = { error: new Error('comment too long') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'add a comment' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('comment too long'))
  })

  it('the internal chat is about this problem, as the signed-in person — or as nobody when unknown', () => {
    const { unmount } = mount('work')
    expect(screen.getByText('internal chat on problem prb-1 as "kc-user-1"')).toBeInTheDocument()
    unmount()
    hoisted.keycloak.subject = undefined
    mount('work')
    expect(screen.getByText('internal chat on problem prb-1 as ""')).toBeInTheDocument()
  })
})

// Review of 23 Sep 2026: every action was offered to read-only roles, and every one ended in a 403.
describe('ProblemDetailPage — who only reads problems', () => {
  it('sees the problem, with the root cause and workaround read only, and no transition or assignment', async () => {
    permissions = []
    const { user } = mount()
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark as known error' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove assignment' })).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    for (const box of screen.queryAllByRole('textbox')) expect(box).toHaveAttribute('readonly')
    // Root cause and workaround are on the diagnosis tab: read only there too, and really there.
    await user.click(screen.getByRole('tab', { name: 'Diagnosis' }))
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
    for (const box of screen.getAllByRole('textbox')) expect(box).toHaveAttribute('readonly')
  })
})

// ── The four tabs (26 Sep 2026, review of the pages) ──────────────────────────

describe('ProblemDetailPage — tabs', () => {
  it('opens on the overview; root cause and workaround are one tab away, open, not folded', async () => {
    const { user } = mount()
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
    expect(screen.queryByPlaceholderText('Describe the root cause of the problem...')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Diagnosis' }))
    expect(screen.getByPlaceholderText('Describe the root cause of the problem...')).toBeVisible()
    expect(screen.getByPlaceholderText('Describe the temporary workaround...')).toBeVisible()
  })
})
