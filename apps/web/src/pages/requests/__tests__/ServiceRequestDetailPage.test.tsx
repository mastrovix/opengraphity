/**
 * Giro nel browser del 14 set 2026 (#41): una richiesta non si poteva
 * assegnare dal suo dettaglio, e ASSIGNEE restava «—». La tendina offre solo
 * chi può lavorare i ticket; una richiesta conclusa mostra il nome e basta.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { GET_SERVICE_REQUEST, GET_USERS } from '@/graphql/queries'
import { ASSIGN_SERVICE_REQUEST_TO_USER } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { ServiceRequestDetailPage } from '../ServiceRequestDetailPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ values: ['low', 'medium', 'high'], loading: false }) }))
vi.mock('@/hooks/useValueStyle', () => ({ useValueStyle: () => () => ({ bg: '', color: '', accent: '' }) }))
vi.mock('@/hooks/useWorkflowSteps', () => ({ useWorkflowSteps: () => ({ labelFor: (s: string) => s, categoryOf: () => 'active' }) }))
vi.mock('@/hooks/useSlaSettling', () => ({ useSlaSettling: () => undefined }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({ useDomainVocabularies: () => ({ labelOf: (_v: string, value: string) => value }) }))
vi.mock('@/components/WatcherBar', () => ({ WatcherBar: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('@/components/ticket/EntityCommentsSection', () => ({ EntityCommentsSection: () => null }))
vi.mock('@/components/InternalChatPanel', () => ({ InternalChatPanel: () => null }))
vi.mock('@/lib/keycloak', () => ({ keycloak: { subject: 'user-1' } }))

const request = (over: Record<string, unknown> = {}) => ({
  __typename: 'ServiceRequest', id: 'sr-1', number: 'SR00000001', tenantId: 'c-test', title: 'Portatile', description: null,
  status: 'in_progress', priority: 'high', dueDate: null, createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z', completedAt: null,
  requestedBy: null, assignee: null, workflowInstance: null, availableTransitions: [], slaStatus: null, ...over,
})
const user = (id: string, name: string, role: string) => ({ __typename: 'User', id, name, email: `${id}@x`, role, createdAt: 'x', teams: [] })
const usersMock: GqlMock = {
  request: { query: GET_USERS },
  result: { data: { users: [user('u-op', 'Olga Operator', 'operator'), user('u-view', 'Vera Viewer', 'viewer'), user('u-portal', 'Paolo Portale', 'end_user')] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

describe('ServiceRequestDetailPage — assegnatario', () => {
  it('offre solo chi lavora i ticket e invia la scelta', async () => {
    const seen: unknown[] = []
    const mocks: GqlMock[] = [
      { request: { query: GET_SERVICE_REQUEST, variables: { id: 'sr-1' } }, result: { data: { serviceRequest: request() } }, maxUsageCount: Number.POSITIVE_INFINITY },
      usersMock,
      {
        request: { query: ASSIGN_SERVICE_REQUEST_TO_USER, variables: (v) => { seen.push(v); return true } },
        result: { data: { assignServiceRequestToUser: { __typename: 'ServiceRequest', id: 'sr-1', assignee: { __typename: 'User', id: 'u-op', name: 'Olga Operator', email: 'u-op@x' } } } },
      },
    ]
    const { user: ue } = renderWithProviders(<ServiceRequestDetailPage />, { mocks, route: '/requests/sr-1', path: '/requests/:id' })
    const select = await screen.findByRole('combobox', { name: 'Assignee' })
    await vi.waitFor(() => expect(within(select).queryByRole('option', { name: 'Olga Operator' })).not.toBeNull())
    expect(within(select).queryByRole('option', { name: 'Vera Viewer' })).toBeNull()
    expect(within(select).queryByRole('option', { name: 'Paolo Portale' })).toBeNull()
    const assign = screen.getByRole('button', { name: 'Assign' })
    expect(assign).toBeDisabled()
    await ue.selectOptions(select, 'u-op')
    await ue.click(assign)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ id: 'sr-1', userId: 'u-op' })
  })

  it('una richiesta conclusa mostra l\'assegnatario senza tendina', async () => {
    const mocks: GqlMock[] = [
      { request: { query: GET_SERVICE_REQUEST, variables: { id: 'sr-1' } }, result: { data: { serviceRequest: request({ completedAt: '2026-09-14T12:00:00Z', assignee: { __typename: 'User', id: 'u-op', name: 'Olga Operator', email: 'u-op@x' } }) } }, maxUsageCount: Number.POSITIVE_INFINITY },
      usersMock,
    ]
    renderWithProviders(<ServiceRequestDetailPage />, { mocks, route: '/requests/sr-1', path: '/requests/:id' })
    expect(await screen.findByText('Olga Operator')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).toBeNull()
  })
})
