/**
 * THE PRIORITY OF A CATALOG ITEM WHEN IT IS MISSING.
 *
 * Requests opened from a catalog item are born with the item's priority, and
 * an item without one cannot be requested at all (the list says «No
 * priority: requests cannot be opened»). The sibling tests cover choosing a
 * priority for a new item; these cover the two ways it can be missing, so
 * the page never saves an item that would stay unrequestable:
 * - an item saved before priorities existed opens with none chosen — not a
 *   default picked for the administrator — and Save waits for a choice;
 * - when the priority vocabulary cannot be read, no priority is invented and
 *   nothing can be saved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { ServiceCatalogAdminPage } from './ServiceCatalogAdminPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const PRIORITIES = [{ value: 'low', label: 'Low', labels: [] }, { value: 'high', label: 'High', labels: [] }]
const withPriorities: DomainVocabularies = {
  valuesOf: (n) => (n === 'priority' ? PRIORITIES.map((p) => p.value) : null),
  entriesOf: (n) => (n === 'priority' ? PRIORITIES : null),
  labelOf: (n, v) => (n === 'priority' ? PRIORITIES.find((p) => p.value === v)?.label ?? null : null),
  colorOf: () => null,
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}
const unread: DomainVocabularies = { ...withPriorities, valuesOf: () => null, entriesOf: () => null, labelOf: () => null }

const item = (over: Record<string, unknown> = {}) => ({
  id: 'cat-1', name: 'New laptop', description: null, category: null, legacyCategory: null,
  requiresApproval: false, priority: 'low', active: true, createdAt: '2026-09-01T00:00:00Z', fulfillmentTeam: null, ...over,
})

const page = (vocabulary: DomainVocabularies) => renderWithProviders(
  <DomainVocabularyContext.Provider value={vocabulary}><ServiceCatalogAdminPage /></DomainVocabularyContext.Provider>,
)

beforeEach(() => {
  apolloFinto.reset()
})

describe('ServiceCatalogAdminPage — a missing priority', () => {
  it('an item saved without a priority opens with none chosen, and Save waits until one is', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [item({ priority: null })] }
    const { user } = page(withPriorities)
    expect(screen.getByText('No priority: requests cannot be opened')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText('Priority *')).toHaveValue('')
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.selectOptions(dialog.getByLabelText('Priority *'), 'high')
    await user.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toMatchObject({ id: 'cat-1', input: { priority: 'high' } }))
  })

  it('when the priority vocabulary cannot be read, no priority is offered and a new item cannot be saved', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [] }
    const { user } = page(unread)
    await user.click(screen.getByRole('button', { name: 'New item' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(within(dialog.getByLabelText('Priority *')).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Choose the priority —'])
    await user.type(dialog.getByPlaceholderText('E.g. New laptop'), 'VPN access')
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(apolloFinto.chiamate['CreateServiceCatalogItem']).toBeUndefined()
  })
})
