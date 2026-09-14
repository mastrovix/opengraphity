/**
 * La scadenza scelta alla creazione arriva all'API (giro nel browser del
 * 14 set 2026). Il modulo raccoglieva «Due date» ma l'input della mutation non
 * la conteneva: la richiesta nasceva senza scadenza, e la si poteva mettere
 * solo modificandola dopo.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { CreateServiceRequestPage } from '../CreateServiceRequestPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))
vi.mock('@/hooks/useSlaCoverageCheck', () => ({ useSlaCoverageCheck: () => async () => 'covered' }))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ values: ['low', 'medium', 'high'], loading: false }) }))
vi.mock('@/hooks/useValueStyle', () => ({ useValueStyle: () => () => ({ bg: '', color: '', accent: '' }) }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({ useDomainVocabularies: () => ({ labelOf: (_v: string, value: string) => value }) }))

describe('CreateServiceRequestPage', () => {
  it('invia la scadenza scelta', async () => {
    const seen: unknown[] = []
    const mocks: GqlMock[] = [
      { request: { query: GET_SERVICE_CATALOG_ADMIN }, result: { data: { serviceCatalogItems: [] } }, maxUsageCount: Number.POSITIVE_INFINITY },
      {
        request: { query: CREATE_SERVICE_REQUEST, variables: (v) => { seen.push(v); return true } },
        result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', title: 'Portatile', priority: 'high', status: 'submitted', createdAt: 'x' } } },
      },
    ]
    const { user, container } = renderWithProviders(<CreateServiceRequestPage />, { mocks })
    await user.type(await screen.findByPlaceholderText('What do you need?'), 'Portatile')
    fireEvent.change(container.querySelector('input[type=date]')!, { target: { value: '2026-09-18' } })
    await user.click(screen.getByRole('button', { name: 'Create the request' }))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ input: { title: 'Portatile', dueDate: '2026-09-18' } })
  })
})
