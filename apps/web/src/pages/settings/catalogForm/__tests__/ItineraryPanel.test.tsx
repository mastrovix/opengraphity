/**
 * WHICH WORKFLOW EACH CATALOG ITEM FOLLOWS.
 *
 * This panel is where an administrator gives an item its own road. If it
 * regresses, the damage is silent and lands on the requester: an item pinned
 * to a switched-off workflow cannot be opened at all, a duplicated copy that
 * never shows up cannot be finished, and a dropdown that shows the wrong
 * default lies about what a new request will do. These tests pin what the
 * panel shows (the default the engine would pick, the "nothing applies"
 * warning) and what it does (assigning, switching on, duplicating).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ItineraryPanel } = await import('../ItineraryPanel')

const DEFS = [
  { id: 'd-gen', name: 'Generic', entityType: 'service_request', category: null, active: true, version: 1 },
  { id: 'd-hw', name: 'Hardware road', entityType: 'service_request', category: 'hardware', active: true, version: 2 },
  { id: 'd-copy', name: 'Access copy', entityType: 'service_request', category: null, active: false, version: 1 },
  // A change workflow has nothing to do with a catalog item: it must never be offered.
  { id: 'd-chg', name: 'Normal change', entityType: 'change', category: null, active: true, version: 1 },
]
const ITEMS = [
  { id: 'i-laptop', name: 'New laptop', category: 'hardware', active: true, workflowDefinitionId: null, workflowDefinitionName: null },
  { id: 'i-access', name: 'New access', category: null, active: true, workflowDefinitionId: 'd-gen', workflowDefinitionName: 'Generic' },
  { id: 'i-old', name: 'Retired item', category: null, active: false, workflowDefinitionId: null, workflowDefinitionName: null },
]

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetCatalogItemsWithWorkflow'] = { serviceCatalogItems: ITEMS }
  apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: DEFS }
})

const rowOf = (name: string) => screen.getByRole('cell', { name }).closest('tr')!

describe('ItineraryPanel: what it shows', () => {
  it('asks for inactive definitions too, otherwise a fresh (switched-off) copy would be invisible', () => {
    renderWithProviders(<ItineraryPanel />)
    expect(apolloFinto.chiamata('GetWorkflowList')).toEqual({ includeInactive: true })
  })

  it('lists only request workflows and only active items', () => {
    renderWithProviders(<ItineraryPanel />)
    expect(screen.queryByText('Normal change')).not.toBeInTheDocument()
    expect(screen.queryByRole('cell', { name: 'Retired item' })).not.toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'New laptop' })).toBeInTheDocument()
    // The definitions list says what each workflow is for.
    expect(screen.getByText('only for category «hardware»')).toBeInTheDocument()
    expect(screen.getAllByText('for every category')).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'Open in the designer' })[0]).toHaveAttribute('href', '/workflow/d-gen')
  })

  it('an unpinned item shows the workflow the engine would pick today, a pinned one its own', () => {
    renderWithProviders(<ItineraryPanel />)
    const laptop = within(rowOf('New laptop')).getByRole('combobox')
    expect(laptop).toHaveValue('d-hw')
    expect(within(rowOf('New laptop')).getByRole('cell', { name: 'hardware' })).toBeInTheDocument()
    expect(within(rowOf('New access')).getByRole('combobox')).toHaveValue('d-gen')
    expect(within(rowOf('New access')).getByRole('cell', { name: '—' })).toBeInTheDocument()
    // A switched-off copy is offered, but labelled as off.
    expect(within(laptop).getByRole('option', { name: 'Access copy · off' })).toBeInTheDocument()
    expect(screen.queryByText(/No workflow applies/)).not.toBeInTheDocument()
  })

  it('when no workflow applies it says so, instead of showing a first option that would be false', () => {
    apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [DEFS[1], DEFS[2]] }
    apolloFinto.risposte['GetCatalogItemsWithWorkflow'] = {
      serviceCatalogItems: [{ ...ITEMS[0], id: 'i-sw', name: 'Software', category: 'software' }],
    }
    renderWithProviders(<ItineraryPanel />)
    const select = within(rowOf('Software')).getByRole('combobox')
    expect(select).toHaveValue('')
    expect(within(select).getByRole('option', { name: '—' })).toBeInTheDocument()
    expect(screen.getByText('No workflow applies: a new request of this item cannot start.')).toBeInTheDocument()
  })

  it('an empty catalog and no definitions say so, and the definitions block is not drawn', () => {
    apolloFinto.risposte['GetCatalogItemsWithWorkflow'] = undefined
    apolloFinto.risposte['GetWorkflowList'] = undefined
    renderWithProviders(<ItineraryPanel />)
    expect(screen.getByText(/There is no active catalog item/)).toBeInTheDocument()
    expect(screen.queryByText('Available workflows')).not.toBeInTheDocument()
    // Approvers live on the workflow: the panel points there.
    expect(screen.getByRole('link', { name: /Workflow/ })).toHaveAttribute('href', '/workflow')
  })
})

describe('ItineraryPanel: assigning a workflow', () => {
  it('picking an active workflow pins it on the item', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['UpdateServiceCatalogItem'] = { data: { updateServiceCatalogItem: { id: 'i-laptop' } } }
    await user.selectOptions(within(rowOf('New laptop')).getByRole('combobox'), 'd-gen')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Workflow assigned'))
    expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toEqual({ id: 'i-laptop', input: { workflowDefinitionId: 'd-gen' } })
    expect(apolloFinto.chiamate['SetWorkflowDefinitionActive']).toBeUndefined()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('picking a switched-off workflow switches it on first, because the API refuses an inactive one', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['SetWorkflowDefinitionActive'] = { data: { setWorkflowDefinitionActive: { id: 'd-copy' } } }
    apolloFinto.esiti['UpdateServiceCatalogItem'] = { data: { updateServiceCatalogItem: { id: 'i-laptop' } } }
    await user.selectOptions(within(rowOf('New laptop')).getByRole('combobox'), 'd-copy')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('«Access copy» was off')))
    expect(apolloFinto.chiamata('SetWorkflowDefinitionActive')).toEqual({ definitionId: 'd-copy', active: true })
    expect(apolloFinto.chiamata('UpdateServiceCatalogItem')).toMatchObject({ input: { workflowDefinitionId: 'd-copy' } })
  })

  it('if switching on fails, the item is NOT assigned (it would be pinned to a road nobody can travel)', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['SetWorkflowDefinitionActive'] = { error: new Error('forbidden') }
    await user.selectOptions(within(rowOf('New laptop')).getByRole('combobox'), 'd-copy')
    await waitFor(() => expect(apolloFinto.chiamate['SetWorkflowDefinitionActive']).toHaveLength(1))
    expect(apolloFinto.chiamate['UpdateServiceCatalogItem']).toBeUndefined()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a failed assignment gives no success message', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['UpdateServiceCatalogItem'] = { error: new Error('nope') }
    await user.selectOptions(within(rowOf('New laptop')).getByRole('combobox'), 'd-gen')
    await waitFor(() => expect(apolloFinto.chiamate['UpdateServiceCatalogItem']).toHaveLength(1))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('ItineraryPanel: switching a workflow on and off', () => {
  it('the checkbox switches a workflow on or off and says which', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['SetWorkflowDefinitionActive'] = { data: { setWorkflowDefinitionActive: { id: 'x' } } }
    const boxes = screen.getAllByRole('checkbox')
    await user.click(boxes[0]!) // Generic: on → off
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Workflow switched off'))
    expect(apolloFinto.chiamata('SetWorkflowDefinitionActive')).toEqual({ definitionId: 'd-gen', active: false })
    await user.click(boxes[2]!) // Access copy: off → on
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Workflow in service'))
    expect(apolloFinto.chiamata('SetWorkflowDefinitionActive')).toEqual({ definitionId: 'd-copy', active: true })
  })

  it('a refused switch says nothing about success', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['SetWorkflowDefinitionActive'] = { error: new Error('no') }
    await user.click(screen.getAllByRole('checkbox')[0]!)
    await waitFor(() => expect(apolloFinto.chiamate['SetWorkflowDefinitionActive']).toHaveLength(1))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('ItineraryPanel: duplicating a workflow', () => {
  it('needs both a source and a non-blank name', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    const button = screen.getByRole('button', { name: /Duplicate/ })
    expect(button).toBeDisabled()
    const [source] = screen.getAllByRole('combobox')
    await user.selectOptions(source!, 'd-hw')
    expect(button).toBeDisabled()
    await user.type(screen.getByPlaceholderText('New access request'), '   ')
    expect(button).toBeDisabled()
    // The source dropdown tells category and off-state apart.
    expect(within(source!).getByRole('option', { name: 'Hardware road · hardware' })).toBeInTheDocument()
    expect(within(source!).getByRole('option', { name: 'Access copy · off' })).toBeInTheDocument()
  })

  it('duplicates with the trimmed name, clears the field and rereads the definitions', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['DuplicateWorkflowDefinition'] = { data: { duplicateWorkflowDefinition: { id: 'd-new' } } }
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'd-hw')
    const name = screen.getByPlaceholderText('New access request')
    await user.type(name, '  Laptop for interns ')
    await user.click(screen.getByRole('button', { name: /Duplicate/ }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Workflow duplicated, switched off'))
    expect(apolloFinto.chiamata('DuplicateWorkflowDefinition')).toEqual({ definitionId: 'd-hw', name: 'Laptop for interns', category: null })
    expect(name).toHaveValue('')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a failed duplication keeps the typed name, so it can be retried', async () => {
    const { user } = renderWithProviders(<ItineraryPanel />)
    apolloFinto.esiti['DuplicateWorkflowDefinition'] = { error: new Error('boom') }
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'd-hw')
    const name = screen.getByPlaceholderText('New access request')
    await user.type(name, 'Copy')
    await user.click(screen.getByRole('button', { name: /Duplicate/ }))
    await waitFor(() => expect(apolloFinto.chiamate['DuplicateWorkflowDefinition']).toHaveLength(1))
    expect(name).toHaveValue('Copy')
    expect(toast.success).not.toHaveBeenCalled()
  })
})
