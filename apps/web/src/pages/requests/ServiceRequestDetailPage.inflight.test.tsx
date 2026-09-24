/**
 * THE SERVICE REQUEST DETAIL, AGAINST THE REAL APOLLO CLIENT.
 *
 * The sibling files answer by operation name, and that fake resolves a failed
 * mutation. Apollo Client 4 does not: it calls `onError` and then REJECTS the
 * promise. The page chains «Moved to …» on that promise, so only the real
 * client can prove the two things that matter when a workflow move fails or
 * takes its time:
 *  - a move that fails on the server shows the error and never also says
 *    «Moved to …» (the promise is caught, not left unhandled);
 *  - while a move or a save is on its way, the buttons wait and say so.
 * Also here, because they are cheap with real responses: the SLA badge, and a
 * priority the Dictionary has no label for, shown as it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { GET_SERVICE_REQUEST } from '@/graphql/queries'
import { EXECUTE_WORKFLOW_TRANSITION, UPDATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { ServiceRequestDetailPage } from './ServiceRequestDetailPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))
vi.mock('@/hooks/useMe', () => ({ useMe: () => ({ can: () => true }) }))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ values: ['low', 'urgent'], loading: false }) }))
vi.mock('@/hooks/useValueStyle', () => ({ useValueStyle: () => () => ({ bg: '', color: '', accent: '' }) }))
vi.mock('@/hooks/useWorkflowSteps', () => ({
  useWorkflowSteps: () => ({ labelFor: (s: string) => ({ approval: 'Approval', fulfilled: 'Fulfilled' }[s] ?? s), categoryOf: () => 'active' }),
}))
vi.mock('@/hooks/useSlaSettling', () => ({ useSlaSettling: () => undefined }))
vi.mock('@/hooks/useTicketCIExclusions', () => ({ useTicketCIExclusions: () => ({ excluded: [], error: undefined }) }))
// Only «low» has a label in this tenant's Dictionary.
vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({ labelOf: (voc: string, value: string) => (voc === 'priority' && value === 'low' ? 'Low (P4)' : null) }),
}))
vi.mock('@/components/WatcherBar', () => ({ WatcherBar: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('@/components/ticket/EntityCommentsSection', () => ({ EntityCommentsSection: () => null }))
vi.mock('@/components/InternalChatPanel', () => ({ InternalChatPanel: () => null }))
vi.mock('@/components/ticket/TicketTasksSection', () => ({ TicketTasksSection: () => null }))
vi.mock('@/components/ticket/ola/TicketOLACard', () => ({ TicketOLACard: () => null }))
vi.mock('@/components/ticket/FormAnswersCard', () => ({ FormAnswersCard: () => null }))
vi.mock('@/components/ticket/customFields/CustomFieldsCard', () => ({ CustomFieldsCard: () => null }))
vi.mock('@/components/ticket/AffectedCIList', () => ({ AffectedCIList: () => null }))
vi.mock('@/pages/requests/RequestAssignment', () => ({ RequestAssignment: () => null }))

const request = (over: Record<string, unknown> = {}) => ({
  __typename: 'ServiceRequest', id: 'sr-1', number: 'SR00000001', tenantId: 'c-test', title: 'Laptop', description: 'A new one',
  status: 'approval', priority: 'urgent', dueDate: null, createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z', completedAt: null,
  requestedBy: null, assignee: null, team: null,
  workflowInstance: { __typename: 'WorkflowInstance', id: 'wi-1', currentStep: 'approval', status: 'running' },
  availableTransitions: [
    { __typename: 'WorkflowTransition', toStep: 'fulfilled', label: 'Approve', labels: [], requiresInput: false, inputField: null },
    { __typename: 'WorkflowTransition', toStep: 'rejected', label: 'Reject', labels: [], requiresInput: true, inputField: 'rejection_reason' },
  ],
  slaStatus: null, customFields: [], affectedCIs: [], formRevision: null, formAnswers: [],
  ...over,
})
const requestMock = (sr = request()): GqlMock => ({
  request: { query: GET_SERVICE_REQUEST, variables: { id: 'sr-1' } },
  result: { data: { serviceRequest: sr } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})
const approve = (answer: Pick<GqlMock, 'result' | 'error'>, delay = 0): GqlMock => ({
  request: { query: EXECUTE_WORKFLOW_TRANSITION, variables: { instanceId: 'wi-1', toStep: 'fulfilled', notes: null } },
  ...answer, delay,
})
const moved = {
  data: { executeWorkflowTransition: {
    __typename: 'TransitionResult', success: true, error: null, errorKey: null, errorParams: null,
    instance: { __typename: 'WorkflowInstance', id: 'wi-1', currentStep: 'fulfilled', status: 'running' },
  } },
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

const mount = (mocks: GqlMock[]) =>
  renderWithProviders(<ServiceRequestDetailPage />, { mocks, route: '/requests/sr-1', path: '/requests/:id' })

describe('ServiceRequestDetailPage with the real Apollo client', () => {
  it('a move that fails on the server shows the error, and never also "Moved to"', async () => {
    // A network failure: the page shows it itself (GraphQL errors are shown once, by the error link).
    const { user } = mount([requestMock(), approve({ error: new Error('The workflow engine is unreachable') })])
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The workflow engine is unreachable'))
    expect(toast.success).not.toHaveBeenCalled()
    // The buttons are given back for another try.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())
  })

  it('while a move is on its way no other move can start, and its outcome is said once it arrives', async () => {
    /*
     * The answer takes 600 ms: long enough that the in-flight state is still
     * there when it is looked at, even on a loaded machine. With 40 ms the
     * answer sometimes arrived between the two checks, under the coverage run
     * (24 Sep 2026). Both are checked in the same look.
     */
    const { user } = mount([requestMock(), approve({ result: moved }, 600)])
    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Approve' })).toHaveStyle({ opacity: '0.6' })
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Moved to Fulfilled'), { timeout: 3000 })
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('while an edit is saved the button says so and waits', async () => {
    const save: GqlMock = {
      request: { query: UPDATE_SERVICE_REQUEST, variables: { id: 'sr-1', input: { title: 'Laptop', description: 'A new one', priority: 'urgent', dueDate: null } } },
      result: { data: { updateServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', title: 'Laptop', description: 'A new one', status: 'approval', priority: 'urgent', dueDate: null } } },
      delay: 600,   // the in-flight state must still be there when looked at (see above)
    }
    const { user } = mount([requestMock(), save])
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit the request' })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('button', { name: 'Saving...' })).toBeDisabled()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Request updated'), { timeout: 3000 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a priority the Dictionary has no label for is shown as it is, in the header and in the edit form', async () => {
    const { user } = mount([requestMock()])
    expect(await screen.findByText('urgent')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const priority = within(screen.getByRole('dialog', { name: 'Edit the request' })).getByLabelText('Priority')
    expect(within(priority).getAllByRole('option').map((o) => o.textContent)).toEqual(['Low (P4)', 'urgent'])
    expect(priority).toHaveValue('urgent')
  })

  it('an SLA shows its state instead of "No SLA"', async () => {
    mount([requestMock(request({ slaStatus: {
      __typename: 'SlaStatus', startedAt: '2026-09-14T10:00:00Z', responseDeadline: '2026-09-14T11:00:00Z', resolveDeadline: '2026-09-15T10:00:00Z',
      responseMet: true, resolveMet: true, breached: false, pausedAt: null, warningMinutes: 30,
    } }))])
    expect(await screen.findByText('SLA met')).toBeInTheDocument()
    expect(screen.queryByText('No SLA')).not.toBeInTheDocument()
  })
})
