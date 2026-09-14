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
    await user.selectOptions(screen.getByLabelText(/Priority/), 'high')
    await user.click(screen.getByRole('button', { name: 'Create the request' }))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ input: { title: 'Portatile', dueDate: '2026-09-18', priority: 'high' } })
  })

  /** Verifica «Cosa resta cablato», ondata 1: la priorità non parte più da «medium». */
  it('nessuna priorità preselezionata: senza sceglierla la richiesta non parte', async () => {
    const seen: unknown[] = []
    const mocks: GqlMock[] = [
      { request: { query: GET_SERVICE_CATALOG_ADMIN }, result: { data: { serviceCatalogItems: [] } }, maxUsageCount: Number.POSITIVE_INFINITY },
      { request: { query: CREATE_SERVICE_REQUEST, variables: (v) => { seen.push(v); return true } }, result: { data: { createServiceRequest: { __typename: 'ServiceRequest', id: 'sr-1', title: 'T', priority: 'low', status: 'submitted', createdAt: 'x' } } } },
    ]
    const { user } = renderWithProviders(<CreateServiceRequestPage />, { mocks })
    await user.type(await screen.findByPlaceholderText('What do you need?'), 'Portatile')
    expect(screen.getByLabelText(/Priority/)).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Create the request' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toHaveLength(0)
  })

  it('scegliendo una voce del catalogo la priorità è quella della voce', async () => {
    const mocks: GqlMock[] = [
      { request: { query: GET_SERVICE_CATALOG_ADMIN }, result: { data: { serviceCatalogItems: [
        { __typename: 'ServiceCatalogItem', id: 'cat-1', name: 'Sblocco account', description: null, category: 'Access', requiresApproval: false, priority: 'high', active: true, createdAt: 'x' },
      ] } }, maxUsageCount: Number.POSITIVE_INFINITY },
    ]
    const { user } = renderWithProviders(<CreateServiceRequestPage />, { mocks })
    await user.selectOptions(await screen.findByRole('combobox', { name: /catalog/i }), 'cat-1')
    expect(screen.getByLabelText(/Priority/)).toHaveValue('high')
  })
})
