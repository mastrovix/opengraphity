/**
 * THE SERVICE REQUEST DETAIL: WORKING A REQUEST.
 *
 * This is where an agent moves a request along its workflow, fixes its
 * fields, links the CIs it is about and hands it to a colleague. The
 * behaviours pinned here are the ones whose regression a user would feel
 * directly:
 *  - a transition refused by a guard must NOT also say "Moved to …" (it did,
 *    revisione totale · F-3), and a transition that needs a reason must not
 *    fire without one;
 *  - the edit form must send what was typed (trimmed, blanks as null), or the
 *    request loses its description or gets a date it never had;
 *  - a missing or failing request must say so and offer a way back, not a
 *    blank page.
 * Children with their own data (OLA, custom fields, comments, chat…) are
 * stubbed: they are tested on their own, here they would only add noise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
const perms = vi.hoisted(() => ({ list: ['ticket.work'] as string[] }))
vi.mock('@/hooks/useMe', () => ({ useMe: () => ({ can: (...p: string[]) => p.some((x) => perms.list.includes(x)) }) }))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ values: ['low', 'medium', 'high'], loading: false }) }))
vi.mock('@/hooks/useValueStyle', () => ({ useValueStyle: () => () => ({ bg: '', color: '', accent: '' }) }))
vi.mock('@/hooks/useWorkflowSteps', () => ({
  useWorkflowSteps: () => ({ labelFor: (s: string) => ({ approval: 'Approval', fulfilled: 'Fulfilled', rejected: 'Rejected' }[s] ?? s), categoryOf: () => 'active' }),
}))
vi.mock('@/hooks/useSlaSettling', () => ({ useSlaSettling: () => undefined }))
vi.mock('@/hooks/useTicketCIExclusions', () => ({ useTicketCIExclusions: () => ({ excluded: ['network'], error: undefined }) }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({ useDomainVocabularies: () => ({ labelOf: (_v: string, value: string) => value.toUpperCase() }) }))
vi.mock('@/components/WatcherBar', () => ({ WatcherBar: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('@/components/ticket/EntityCommentsSection', () => ({ EntityCommentsSection: () => null }))
vi.mock('@/components/InternalChatPanel', () => ({ InternalChatPanel: () => null }))
vi.mock('@/components/ticket/TicketTasksSection', () => ({ TicketTasksSection: () => null }))
vi.mock('@/components/ticket/ola/TicketOLACard', () => ({ TicketOLACard: () => null }))
vi.mock('@/components/ticket/FormAnswersCard', () => ({ FormAnswersCard: () => null }))
vi.mock('@/components/ticket/customFields/CustomFieldsCard', () => ({
  CustomFieldsCard: ({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) => (
    <button type="button" onClick={onSaved}>{canEdit ? 'custom fields editable' : 'custom fields read-only'}</button>
  ),
}))
// The CI list is its own component; the page's job is to wire search, add and remove to the request.
vi.mock('@/components/ticket/AffectedCIList', () => ({
  AffectedCIList: ({ ciResults, excludedTypes, onSearchChange, onAddCI, onRemoveCI }: {
    ciResults: Array<{ id: string; name: string }>; excludedTypes: readonly string[]
    onSearchChange: (s: string) => void; onAddCI: (id: string) => void; onRemoveCI: (id: string) => void
  }) => (
    <div data-testid="ci-list" data-excluded={excludedTypes.join(',')}>
      <button type="button" onClick={() => onSearchChange('web')}>search web</button>
      {ciResults.map((c) => <button type="button" key={c.id} onClick={() => onAddCI(c.id)}>add {c.name}</button>)}
      <button type="button" onClick={() => onRemoveCI('ci-old')}>remove old</button>
    </div>
  ),
}))
vi.mock('@/lib/keycloak', () => ({ keycloak: { subject: undefined } }))

const { ServiceRequestDetailPage } = await import('../ServiceRequestDetailPage')

const request = (over: Record<string, unknown> = {}) => ({
  id: 'sr-1', number: 'SR00000001', title: 'Laptop', description: 'A new one', status: 'approval', priority: 'high',
  dueDate: '2026-10-01T00:00:00Z', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z', completedAt: null,
  requestedBy: { id: 'u-req', name: 'Rita Requester', email: 'r@x' }, assignee: null,
  workflowInstance: { id: 'wi-1', currentStep: 'approval', status: 'running' },
  availableTransitions: [
    { toStep: 'fulfilled', label: 'Approve', labels: [], requiresInput: false, inputField: null },
    { toStep: 'rejected', label: 'Reject', labels: [], requiresInput: true, inputField: 'rejection_reason' },
    { toStep: 'approval', label: 'Add note', labels: [], requiresInput: true, inputField: 'notes' },
  ],
  slaStatus: null, affectedCIs: [], formRevision: null, formAnswers: [], customFields: [],
  team: { id: 't-desk', name: 'SUP_Service Desk' }, ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  perms.list = ['ticket.work', 'request.write']
  apolloFinto.risposte['GetServiceRequest'] = { serviceRequest: request() }
  apolloFinto.risposte['GetAssignableUsers'] = { users: [] }
})

const mount = () => renderWithProviders(<ServiceRequestDetailPage />, { route: '/requests/sr-1', path: '/requests/:id' })

describe('ServiceRequestDetailPage: when there is no request to show', () => {
  it('a request that does not exist says so and leads back to the list', async () => {
    apolloFinto.risposte['GetServiceRequest'] = { serviceRequest: null }
    const { user } = mount()
    expect(screen.getByText('Service request not found.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to list' }))
    await attendiURL('/requests')
  })

  it('a failed load shows the error with a retry, not an empty page', async () => {
    apolloFinto.erroriQuery['GetServiceRequest'] = new Error('network down')
    const { user } = mount()
    expect(screen.getByText(/network down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('ServiceRequestDetailPage: an action that ends the request badly looks like one (D27)', () => {
  it('«Reject» — it asks for a rejection reason — is drawn as danger; approving keeps the primary style', async () => {
    const { user } = mount()
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveStyle({ backgroundColor: 'var(--color-danger)' })
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveStyle({ backgroundColor: 'var(--color-brand)' })
    expect(screen.getByRole('button', { name: 'Add note' })).toHaveStyle({ backgroundColor: 'var(--color-brand)' })
    // The confirmation of the rejection says the same thing.
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toHaveStyle({ backgroundColor: 'var(--color-danger)' })
  })
})

describe('ServiceRequestDetailPage: what it shows', () => {
  it('header, details, and the back link', async () => {
    const { user } = mount()
    expect(apolloFinto.chiamata('GetServiceRequest')).toEqual({ id: 'sr-1' })
    expect(screen.getByRole('heading', { name: 'Laptop' })).toBeInTheDocument()
    // The status is the workflow step's label, the priority the vocabulary's.
    expect(screen.getAllByText('Approval').length).toBeGreaterThan(0)
    expect(screen.getByText('HIGH')).toBeInTheDocument()
    expect(screen.getByText('A new one')).toBeInTheDocument()
    expect(screen.getByText('Rita Requester')).toBeInTheDocument()
    expect(screen.getByText('No SLA')).toBeInTheDocument()
    // Excluded CI types reach the CI list, so it never proposes them.
    expect(screen.getByTestId('ci-list')).toHaveAttribute('data-excluded', 'network')
    await user.click(screen.getByRole('button', { name: /← Requests/ }))
    await attendiURL('/requests')
  })

  it('custom fields are editable only with the permission the API checks, and a save rereads the request', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'custom fields editable' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('without ticket.work the custom fields are read-only', () => {
    perms.list = []
    mount()
    expect(screen.getByRole('button', { name: 'custom fields read-only' })).toBeInTheDocument()
  })

  it('without a workflow, or with no action in the current step, it says so instead of an empty box', () => {
    apolloFinto.risposte['GetServiceRequest'] = { serviceRequest: request({ workflowInstance: null, description: null }) }
    const { unmount } = mount()
    expect(screen.getByText('No workflow attached to this request.')).toBeInTheDocument()
    expect(screen.getByText('No description.')).toBeInTheDocument()
    unmount()
    apolloFinto.risposte['GetServiceRequest'] = { serviceRequest: request({ availableTransitions: [] }) }
    mount()
    expect(screen.getByText('No action available in the current status (Approval).')).toBeInTheDocument()
  })

  it('a completed request shows its completion date and no assignee dropdown', () => {
    apolloFinto.risposte['GetServiceRequest'] = { serviceRequest: request({ completedAt: '2026-09-20T10:00:00Z', dueDate: null }) }
    mount()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).not.toBeInTheDocument()
  })
})

describe('ServiceRequestDetailPage: transitions', () => {
  it('a transition without input runs at once and says where the request went', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { data: { executeWorkflowTransition: { success: true, error: null } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Moved to Fulfilled'))
    expect(apolloFinto.chiamata('ExecuteWorkflowTransition')).toEqual({ instanceId: 'wi-1', toStep: 'fulfilled', notes: null })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a transition refused by the engine shows the reason and NOT "Moved to"', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { data: { executeWorkflowTransition: { success: false, error: 'Guard failed' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Guard failed'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a refusal without a message falls back to a generic one', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { data: { executeWorkflowTransition: { success: false, error: null } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Transition failed'))
  })

  it('a rejection asks for the reason and cannot be confirmed blank; the reason is sent trimmed', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { data: { executeWorkflowTransition: { success: true, error: null } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject' })
    const reason = within(dialog).getByLabelText('Reason for rejection')
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    await user.type(reason, '   ')
    expect(confirm).toBeDisabled()
    await user.type(reason, 'Not budgeted  ')
    await user.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reject' })).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('ExecuteWorkflowTransition')).toEqual({ instanceId: 'wi-1', toStep: 'rejected', notes: 'Not budgeted' })
  })

  it('a transition with a generic input asks for a note, and cancelling sends nothing', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Add note' }))
    const dialog = screen.getByRole('dialog', { name: 'Add note' })
    expect(within(dialog).getByLabelText('Note')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['ExecuteWorkflowTransition']).toBeUndefined()
  })

  it('a refused transition keeps the reason dialog open, so the reason is not lost', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { data: { executeWorkflowTransition: { success: false, error: 'No' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject' })
    await user.type(within(dialog).getByLabelText('Reason for rejection'), 'Because')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No'))
    expect(within(screen.getByRole('dialog', { name: 'Reject' })).getByLabelText('Reason for rejection')).toHaveValue('Because')
  })
})

describe('ServiceRequestDetailPage: editing', () => {
  it('opens with the current values and sends them trimmed, blanks as null', async () => {
    apolloFinto.esiti['UpdateServiceRequest'] = { data: { updateServiceRequest: { id: 'sr-1' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit the request' })
    const title = within(dialog).getByLabelText('Title *')
    expect(title).toHaveValue('Laptop')
    expect(within(dialog).getByLabelText('Due date')).toHaveValue('2026-10-01')
    await user.clear(title)
    await user.type(title, '  Laptop for Rita ')
    await user.clear(within(dialog).getByLabelText('Description'))
    await user.type(within(dialog).getByLabelText('Description'), '   ')
    await user.selectOptions(within(dialog).getByLabelText('Priority'), 'low')
    await user.clear(within(dialog).getByLabelText('Due date'))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Request updated'))
    expect(apolloFinto.chiamata('UpdateServiceRequest')).toEqual({
      id: 'sr-1', input: { title: 'Laptop for Rita', description: null, priority: 'low', dueDate: null },
    })
    expect(screen.queryByRole('dialog', { name: 'Edit the request' })).not.toBeInTheDocument()
  })

  it('a blank title cannot be saved, and a request without description or due date opens with empty fields', async () => {
    apolloFinto.risposte['GetServiceRequest'] = { serviceRequest: request({ description: null, dueDate: null }) }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit the request' })
    expect(within(dialog).getByLabelText('Description')).toHaveValue('')
    expect(within(dialog).getByLabelText('Due date')).toHaveValue('')
    await user.clear(within(dialog).getByLabelText('Title *'))
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('ServiceRequestDetailPage: CIs and assignee', () => {
  it('searches CIs with the excluded types, links one and removes another', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [{ id: 'ci-web', name: 'web-01' }] } }
    const { user } = mount()
    // Under two characters there is no search at all.
    expect(apolloFinto.chiamate['GetAllCIs']).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'search web' }))
    expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ search: 'web', limit: 20, excludeCiTypes: ['network'] })
    await user.click(screen.getByRole('button', { name: 'add web-01' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI linked to the request'))
    expect(apolloFinto.chiamata('AddCIToServiceRequest')).toEqual({ requestId: 'sr-1', ciId: 'ci-web' })
    await user.click(screen.getByRole('button', { name: 'remove old' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('CI removed from the request'))
    expect(apolloFinto.chiamata('RemoveCIFromServiceRequest')).toEqual({ requestId: 'sr-1', ciId: 'ci-old' })
  })

  it('unassigning sends null, and a deactivated person is never offered', async () => {
    apolloFinto.risposte['GetServiceRequest'] = { serviceRequest: request({ assignee: { id: 'u-op', name: 'Olga', email: 'o@x' } }) }
    apolloFinto.risposte['GetAssignableUsers'] = { users: [
      { id: 'u-op', name: 'Olga', permissions: ['ticket.assignable'], active: true, teams: [{ id: 't-desk' }] },
      { id: 'u-gone', name: 'Gone', permissions: ['ticket.assignable'], active: false, teams: [{ id: 't-desk' }] },
    ] }
    apolloFinto.esiti['AssignServiceRequestToUser'] = { data: { assignServiceRequestToUser: { id: 'sr-1' } } }
    const { user } = mount()
    const select = screen.getByRole('combobox', { name: 'Assignee' })
    expect(select).toHaveValue('u-op')
    expect(within(select).queryByRole('option', { name: 'Gone' })).not.toBeInTheDocument()
    await user.selectOptions(select, '')
    await user.click(screen.getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Request assigned'))
    expect(apolloFinto.chiamata('AssignServiceRequestToUser')).toEqual({ id: 'sr-1', userId: null })
  })
})

describe('ServiceRequestDetailPage: failures are shown, and nothing pretends to have worked', () => {
  it('a failed save keeps the edit dialog open with what was typed', async () => {
    apolloFinto.esiti['UpdateServiceRequest'] = { error: new Error('save refused') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit the request' })
    await user.type(within(dialog).getByLabelText('Title *'), ' v2')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('save refused'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(within(screen.getByRole('dialog', { name: 'Edit the request' })).getByLabelText('Title *')).toHaveValue('Laptop v2')
    // The header close button also closes it.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('failed CI link, CI removal and assignment each show their error and no success', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [{ id: 'ci-web', name: 'web-01' }] } }
    apolloFinto.risposte['GetAssignableUsers'] = { users: [{ id: 'u-op', name: 'Olga', permissions: ['ticket.assignable'], active: true, teams: [{ id: 't-desk' }] }] }
    apolloFinto.esiti['AddCIToServiceRequest'] = { error: new Error('excluded type') }
    apolloFinto.esiti['RemoveCIFromServiceRequest'] = { error: new Error('not linked') }
    apolloFinto.esiti['AssignServiceRequestToUser'] = { error: new Error('not assignable') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'search web' }))
    await user.click(screen.getByRole('button', { name: 'add web-01' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('excluded type'))
    await user.click(screen.getByRole('button', { name: 'remove old' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not linked'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assignee' }), 'u-op')
    await user.click(screen.getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not assignable'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a transition that errors shows the error, and the reason dialog can be closed from its header', async () => {
    apolloFinto.esiti['ExecuteWorkflowTransition'] = { error: new Error('engine down') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject' })
    await user.type(within(dialog).getByLabelText('Reason for rejection'), 'Because')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('engine down'))
    await user.click(within(screen.getByRole('dialog', { name: 'Reject' })).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// Review of 23 Sep 2026: every action was offered to read-only roles, and every one ended in a 403.
describe('ServiceRequestDetailPage — who only reads requests', () => {
  it('sees the request, and no Edit, no transition, no assignment control', async () => {
    perms.list = []
    mount()
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    for (const name of [/^Edit$/, 'Approve', 'Reject']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).toBeNull()
  })
})
