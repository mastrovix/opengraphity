/**
 * The service catalog admin page decides what people can request from the
 * self-service portal. Beyond the priority (covered in the sibling test),
 * what must hold for an admin:
 * - an item whose category was typed by hand before the Dictionary is
 *   flagged, in the list and in the editor, so it gets fixed (SLA policies by
 *   category do not apply to it otherwise);
 * - editing sends the item's own id with the trimmed values, and an empty
 *   description/category are sent as null, not as '';
 * - deactivating/activating flips only the `active` flag;
 * - an empty catalog and a load error each say what happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { ServiceCatalogAdminPage } from './ServiceCatalogAdminPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const VOCAB: Record<string, { value: string; label: string; labels: [] }[]> = {
  priority: [{ value: 'low', label: 'Low', labels: [] }, { value: 'high', label: 'High', labels: [] }],
  category: [{ value: 'hardware', label: 'Hardware', labels: [] }, { value: 'access', label: 'Access', labels: [] }],
}

const item = (over: Record<string, unknown>) => ({
  id: 'cat-1', name: 'New laptop', description: null, category: 'hardware', legacyCategory: null,
  requiresApproval: false, priority: 'low', active: true, createdAt: 'x', fulfillmentTeam: null, ...over,
})

function page() {
  return renderWithProviders(
    <DomainVocabularyContext.Provider value={{
      valuesOf: (n) => VOCAB[n]?.map((e) => e.value) ?? null,
      labelOf: (n, v) => VOCAB[n]?.find((e) => e.value === v)?.label ?? null,
      colorOf: () => null,
      vocabularyLabelOf: () => null,
      entriesOf: (n) => VOCAB[n] ?? null,
      loading: false, error: null,
    }}><ServiceCatalogAdminPage /></DomainVocabularyContext.Provider>,
  )
}

const rowOf = (name: string) => screen.getByText(name).closest('tr')!

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('ServiceCatalogAdminPage — list', () => {
  it('shows category label, description, approval and status of each item', () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [
      item({ description: 'A 14" laptop', requiresApproval: true, fulfillmentTeam: { id: 'sup-1', name: 'SUP_Service Desk' } }),
      item({ id: 'cat-2', name: 'Old item', category: null, legacyCategory: 'Hw stuff', active: false }),
      item({ id: 'cat-3', name: 'Bare item', category: null }),
    ] }
    page()
    const laptop = rowOf('New laptop')
    expect(within(laptop).getByText('Hardware')).toBeInTheDocument()
    expect(within(laptop).getByText('A 14" laptop')).toBeInTheDocument()
    expect(within(laptop).getByText('Required')).toBeInTheDocument()
    expect(within(laptop).getByText('Active')).toBeInTheDocument()
    expect(within(laptop).getByText('SUP_Service Desk')).toBeInTheDocument()
    expect(within(laptop).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()

    const old = rowOf('Old item')
    // A hand-typed category is flagged, not shown as if it were a real one.
    expect(within(old).getByText('«Hw stuff»: choose a category')).toBeInTheDocument()
    expect(within(old).getByText('Inactive')).toBeInTheDocument()
    expect(within(old).getByRole('button', { name: 'Activate' })).toBeInTheDocument()
    expect(within(old).getByText('No')).toBeInTheDocument()

    // No category and no fulfilment group: a dash for each.
    expect(within(rowOf('Bare item')).getAllByText('—')).toHaveLength(2)
  })

  it('an empty catalog invites to create the first item', () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [] }
    page()
    expect(screen.getByText('No catalog items')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('a load error is shown with a retry', async () => {
    apolloFinto.erroriQuery['GetServiceCatalogAdmin'] = new Error('catalog down')
    const { user } = page()
    expect(screen.getByText(/catalog down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry|Try again/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('activate/deactivate flips only the active flag of that item', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [item({ id: 'cat-7', active: false })] }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'Activate' }))
    expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toEqual({ id: 'cat-7', input: { active: true } })
  })
})

describe('ServiceCatalogAdminPage — editor', () => {
  it('editing an item pre-fills the form and sends its id with trimmed values', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [item({ description: 'Old text', requiresApproval: false })] }
    const { user } = page()
    await user.click(within(rowOf('New laptop')).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Edit catalog item')).toBeInTheDocument()
    const name = within(dialog).getByPlaceholderText('E.g. New laptop')
    expect(name).toHaveValue('New laptop')
    await user.clear(name)
    await user.type(name, '  Laptop 14  ')
    await user.clear(within(dialog).getByPlaceholderText('What the service includes...'))
    await user.selectOptions(within(dialog).getByLabelText('Category'), '')
    await user.selectOptions(within(dialog).getByLabelText('Priority *'), 'high')
    await user.selectOptions(within(dialog).getByLabelText('Approval'), 'yes')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toBeDefined())
    expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toEqual({
      id: 'cat-1',
      input: { name: 'Laptop 14', description: null, category: null, requiresApproval: true, priority: 'high', fulfillmentTeamId: null },
    })
    // Saved: the dialog closes and the list is read again.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('the editor of a legacy item tells what the old category was', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [item({ category: null, legacyCategory: 'Hw stuff' })] }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText(/It was «Hw stuff», which matches no category/)).toBeInTheDocument()
  })

  it('creating an item sends it, confirms, and closes the dialog', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [] }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'New item' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('A category of the Dictionary. Requests from this item inherit it, and SLA policies by category apply to them.')).toBeInTheDocument()
    await user.type(within(dialog).getByPlaceholderText('E.g. New laptop'), 'VPN access')
    await user.type(within(dialog).getByPlaceholderText('What the service includes...'), ' Remote access ')
    await user.selectOptions(within(dialog).getByLabelText('Category'), 'access')
    await user.selectOptions(within(dialog).getByLabelText('Priority *'), 'low')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(apolloFinto.chiamata('CreateServiceCatalogItem')).toEqual({
      input: { name: 'VPN access', description: 'Remote access', category: 'access', requiresApproval: false, priority: 'low', fulfillmentTeamId: null },
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('cancel closes the dialog without sending anything', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [] }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'New item' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamate['CreateServiceCatalogItem']).toBeUndefined()
  })

  it('a refused save keeps the dialog open and shows the error', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [item({})] }
    apolloFinto.esiti['UpdateServiceCatalogItem'] = { error: new Error('name taken') }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('name taken'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('a refused creation keeps what was typed and shows the error', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [] }
    apolloFinto.esiti['CreateServiceCatalogItem'] = { error: new Error('quota reached') }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'New item' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByPlaceholderText('E.g. New laptop'), 'VPN access')
    await user.selectOptions(within(dialog).getByLabelText('Priority *'), 'high')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('quota reached'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(within(screen.getByRole('dialog')).getByPlaceholderText('E.g. New laptop')).toHaveValue('VPN access')
  })
})

/**
 * THE FULFILMENT GROUP (D56, tour of 23 Sep 2026): the requests of an item are
 * born assigned to it. Chosen among the support teams, searchable, and it can
 * be removed — an item without one gives requests with no team.
 */
describe('ServiceCatalogAdminPage — fulfilment group', () => {
  const TEAMS = [
    { id: 'sup-1', name: 'SUP_Service Desk', type: 'support', isChangeManager: false },
    { id: 'sup-2', name: 'SUP_Workplace', type: 'support', isChangeManager: false },
    { id: 'own-1', name: 'OWN_Finance', type: 'owner', isChangeManager: false },
  ]
  beforeEach(() => { apolloFinto.risposte['GetTeamChoices'] = { teams: TEAMS } })

  it('a new item gets the support team chosen, searched by name', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [] }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'New item' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByPlaceholderText('E.g. New laptop'), 'Desk move')
    await user.selectOptions(within(dialog).getByLabelText('Priority *'), 'low')
    const picker = within(dialog).getByRole('combobox', { name: 'Fulfilment group' })
    await user.type(picker, 'work')
    // Only support teams: the owner team is not offered.
    expect(screen.queryByRole('option', { name: 'OWN_Finance' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'SUP_Workplace' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('CreateServiceCatalogItem')).toBeDefined())
    expect(apolloFinto.chiamata('CreateServiceCatalogItem')).toMatchObject({ input: { name: 'Desk move', fulfillmentTeamId: 'sup-2' } })
  })

  it('editing shows the group the item has, and removing it sends null', async () => {
    apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: [item({ fulfillmentTeam: { id: 'sup-1', name: 'SUP_Service Desk' } })] }
    const { user } = page()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    const picker = within(dialog).getByRole('combobox', { name: 'Fulfilment group' })
    expect(picker).toHaveValue('SUP_Service Desk')
    expect(within(dialog).getByText(/The requests of this item are born assigned to this team/)).toBeInTheDocument()
    await user.click(picker)
    await user.click(screen.getByRole('option', { name: '— No fulfilment group —' }))
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toBeDefined())
    expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toMatchObject({ id: 'cat-1', input: { fulfillmentTeamId: null } })
  })
})
