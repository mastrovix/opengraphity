/**
 * Verifica «Cosa resta cablato», ondata 1 (scelta del proprietario): la
 * priorità di una richiesta dal catalogo la decide la voce. Il portale mandava
 * `medium` scritto nel codice; ora ogni voce ha la sua priorità, scelta qui.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { GET_SERVICE_CATALOG_ADMIN } from '@/graphql/queries'
import { CREATE_SERVICE_CATALOG_ITEM } from '@/graphql/mutations'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { ServiceCatalogAdminPage } from './ServiceCatalogAdminPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const PRIORITIES = [
  { value: 'low', label: 'Low', labels: [] },
  { value: 'high', label: 'High', labels: [] },
]
const item = (over: Record<string, unknown>) => ({
  __typename: 'ServiceCatalogItem', id: 'cat-1', name: 'Nuovo laptop', description: null, category: 'Hardware',
  requiresApproval: false, priority: 'low', active: true, createdAt: 'x', ...over,
})

function page(mocks: GqlMock[]) {
  return renderWithProviders(
    <DomainVocabularyContext.Provider value={{
      valuesOf: (n) => (n === 'priority' ? PRIORITIES.map((p) => p.value) : null),
      labelOf: (n, v) => (n === 'priority' ? PRIORITIES.find((p) => p.value === v)?.label ?? null : null),
      colorOf: () => null,
      entriesOf: (n) => (n === 'priority' ? PRIORITIES : null),
      loading: false, error: null,
    }}><ServiceCatalogAdminPage /></DomainVocabularyContext.Provider>,
    { mocks },
  )
}

describe('ServiceCatalogAdminPage — priorità della voce', () => {
  it('la lista mostra la priorità di ogni voce, e dice quando manca', async () => {
    const list: GqlMock = { request: { query: GET_SERVICE_CATALOG_ADMIN }, result: { data: { serviceCatalogItems: [item({}), item({ id: 'cat-2', name: 'Vecchia voce', priority: null })] } }, maxUsageCount: Number.POSITIVE_INFINITY }
    page([list])
    expect(await screen.findByText('Low')).toBeInTheDocument()
    expect(screen.getByText('No priority: requests cannot be opened')).toBeInTheDocument()
  })

  it('una voce nuova non si salva senza priorità; con la priorità scelta la manda', async () => {
    const seen: unknown[] = []
    const list: GqlMock = { request: { query: GET_SERVICE_CATALOG_ADMIN }, result: { data: { serviceCatalogItems: [item({})] } }, maxUsageCount: Number.POSITIVE_INFINITY }
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_CATALOG_ITEM, variables: (v) => { seen.push(v); return true } },
      result: { data: { createServiceCatalogItem: item({ id: 'cat-3', name: 'Sblocco account', priority: 'high' }) } },
    }
    const { user } = page([list, create])
    await user.click(await screen.findByRole('button', { name: 'New item' }))
    await user.type(screen.getByPlaceholderText('E.g. New laptop'), 'Sblocco account')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Priority *'), 'high')
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ input: { name: 'Sblocco account', priority: 'high' } })
  })
})
