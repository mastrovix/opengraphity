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
import { fieldRulesMocks } from '@/test/mocks/gql'
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
      ...fieldRulesMocks('service_request'),
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

  /*
   * CAMBIANDO VOCE LA DESCRIZIONE SEGUE (20 set 2026, dal giro nel browser).
   *
   * Era protetta solo dal «vuoto»: quella messa dalla voce di PRIMA
   * sopravviveva al cambio, e una richiesta di accesso nasceva con scritto
   * «Richiesta di un portatile aziendale». Chi guarda due voci prima di
   * decidere mandava una descrizione che parla di un altro servizio.
   */
  const dueVoci = (): GqlMock[] => [
    { request: { query: GET_SERVICE_CATALOG_ADMIN }, result: { data: { serviceCatalogItems: [
      { __typename: 'ServiceCatalogItem', id: 'cat-1', name: 'Nuovo portatile', description: 'Richiesta di un portatile aziendale', category: 'Hardware', requiresApproval: false, priority: 'high', active: true, createdAt: 'x' },
      { __typename: 'ServiceCatalogItem', id: 'cat-2', name: 'Accesso applicazione', description: 'Abilitazione a un applicativo', category: 'Accessi', requiresApproval: false, priority: 'medium', active: true, createdAt: 'x' },
    ] } }, maxUsageCount: Number.POSITIVE_INFINITY },
  ]

  it('cambiando voce la descrizione automatica diventa quella della voce nuova', async () => {
    const { user } = renderWithProviders(<CreateServiceRequestPage />, { mocks: dueVoci() })
    const tendina = await screen.findByRole('combobox', { name: /catalog/i })
    await user.selectOptions(tendina, 'cat-1')
    expect(screen.getByLabelText(/Description/)).toHaveValue('Richiesta di un portatile aziendale')
    await user.selectOptions(tendina, 'cat-2')
    expect(screen.getByLabelText(/Description/)).toHaveValue('Abilitazione a un applicativo')
  })

  it('una descrizione SCRITTA A MANO non si perde cambiando voce', async () => {
    const { user } = renderWithProviders(<CreateServiceRequestPage />, { mocks: dueVoci() })
    const tendina = await screen.findByRole('combobox', { name: /catalog/i })
    await user.selectOptions(tendina, 'cat-1')
    const descrizione = screen.getByLabelText(/Description/)
    await user.clear(descrizione)
    await user.type(descrizione, 'Serve per la nuova assunta')
    await user.selectOptions(tendina, 'cat-2')
    expect(descrizione).toHaveValue('Serve per la nuova assunta')
  })
})
