/**
 * «Create a map»: everything around the two paths the first test file covers.
 *
 * What an admin loses if these regress:
 * - the candidate list: an empty or failed list must be SAID, otherwise the
 *   select just looks empty and the admin thinks there is nothing to map;
 * - the relationships: the tenant's own types (`RUNS_ON`) start ticked like the
 *   API would follow them (G-MON-5); unticking all of them must block creation
 *   with a message, not create a map that follows nothing;
 * - the preview: how many and which components the map would have, BEFORE
 *   creating it — the count, the cap on the listed names, the empty case
 *   (the service realizes nothing) and a failure must each be readable;
 * - the outcome: success opens the new map, a server refusal or an answer
 *   without the map is an error toast, never a silent close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { CreateServiceMapDialog } = await import('./CreateServiceMapDialog')

const BILLING = { id: 'ba-1', name: 'Enterprise Billing', criticality: 'business_critical', ownerGroup: { id: 't1', name: 'Billing Ops' } }
const INTRANET = { id: 'ba-2', name: 'Intranet', criticality: null, ownerGroup: null }
const TENANT_RELS = ['DEPENDS_ON', 'HOSTED_ON', 'RUNS_ON']

const previewNode = (i: number, over: Record<string, unknown> = {}) => ({
  ci: { id: `ci-${i}`, name: `node-${i}`, type: 'server' }, level: 1, role: 'infrastructure', ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  Object.values(toast).forEach((f) => f.mockReset())
  apolloFinto.risposte['GetServiceMapCandidates'] = { serviceMapCandidates: [BILLING, INTRANET] }
  apolloFinto.risposte['GetServiceRelationshipTypes'] = { serviceRelationshipTypes: TENANT_RELS }
  apolloFinto.risposte['GetServiceMapCreationPreview'] = { serviceMapCreationPreview: { serviceName: 'Enterprise Billing', nodes: [previewNode(1)] } }
})

function open(props: { onClose?: () => void; onCreated?: (m: unknown) => void } = {}) {
  const onClose = props.onClose ?? vi.fn()
  const onCreated = props.onCreated ?? vi.fn()
  const utils = renderWithProviders(<CreateServiceMapDialog open onClose={onClose} onCreated={onCreated} />)
  return { ...utils, onClose, onCreated }
}
const serviceSelect = () => screen.getByLabelText('Business application')
const createButton = () => screen.getByRole('button', { name: 'Create' })
const previewSection = () => screen.findByRole('region', { name: 'Preview' })

describe('candidates', () => {
  it('each option says the criticality and the owner team when the service has them', () => {
    open()
    const options = within(serviceSelect()).getAllByRole('option').map((o) => o.textContent)
    expect(options[0]).toBe('— choose a service —')
    expect(options[1]).toMatch(/^Enterprise Billing · .+ · Billing Ops$/)
    expect(options[2]).toBe('Intranet')
  })

  it('a failed list is an alert, not an empty select', () => {
    apolloFinto.erroriQuery['GetServiceMapCandidates'] = new Error('graph down')
    open()
    expect(screen.getByText('Candidates unavailable: graph down')).toHaveAttribute('role', 'alert')
  })

  it('no candidate left is said explicitly', () => {
    apolloFinto.risposte['GetServiceMapCandidates'] = { serviceMapCandidates: [] }
    open()
    expect(screen.getByText('No business application without a map.')).toBeInTheDocument()
  })

  it('the search is trimmed and sent after the debounce', async () => {
    const { user } = open()
    expect(apolloFinto.chiamata('GetServiceMapCandidates')).toEqual({ search: null, limit: 50 })
    await user.type(screen.getByLabelText('Search an application'), '  bill ')
    await waitFor(() => expect(apolloFinto.chiamata('GetServiceMapCandidates')).toEqual({ search: 'bill', limit: 50 }))
  })
})

describe('relationships', () => {
  it('the tenant relationship types all start ticked, its own included', () => {
    open()
    for (const r of TENANT_RELS) expect(screen.getByRole('checkbox', { name: r })).toBeChecked()
  })

  // Review of 23 Sep 2026: mounted closed (query skipped), the selection was fixed on the shipped fallback.
  it('mounted closed and then opened: the tenant types all ticked, and a shipped type it lacks is never sent', async () => {
    apolloFinto.esiti['CreateServiceMap'] = { data: { createServiceMap: { id: 'map-9', name: 'Enterprise Billing' } } }
    const { rerender, user } = renderWithProviders(<CreateServiceMapDialog open={false} onClose={vi.fn()} />)
    rerender(<CreateServiceMapDialog open onClose={vi.fn()} />)
    for (const r of TENANT_RELS) expect(screen.getByRole('checkbox', { name: r })).toBeChecked()
    await user.selectOptions(serviceSelect(), 'ba-1')
    await user.click(screen.getByRole('checkbox', { name: 'HOSTED_ON' }))
    await user.click(createButton())
    await waitFor(() => expect(apolloFinto.chiamata('CreateServiceMap')).toBeDefined())
    expect((apolloFinto.chiamata('CreateServiceMap')!['relationshipTypes'] as string[]).sort()).toEqual(['DEPENDS_ON', 'RUNS_ON'])
  })

  it('a failed load shows the shipped types and says it could not load the tenant ones', () => {
    apolloFinto.erroriQuery['GetServiceRelationshipTypes'] = new Error('forbidden')
    open()
    expect(screen.getByText('Could not load relationship types: forbidden')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'USES_CERTIFICATE' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'RUNS_ON' })).not.toBeInTheDocument()
  })

  it('with no relationship ticked creation is blocked and the reason is shown', async () => {
    const { user } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    for (const r of TENANT_RELS) await user.click(screen.getByRole('checkbox', { name: r }))
    expect(screen.getByText('Choose at least one relationship.')).toBeInTheDocument()
    expect(createButton()).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'RUNS_ON' }))
    expect(screen.queryByText('Choose at least one relationship.')).not.toBeInTheDocument()
    expect(createButton()).toBeEnabled()
  })

  it('a depth that is not a number blocks creation', async () => {
    const { user } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    await user.clear(screen.getByLabelText('Maximum depth'))
    expect(createButton()).toBeDisabled()
  })
})

describe('preview', () => {
  it('lists the components with the settings chosen, capped at twelve names', async () => {
    const nodes = Array.from({ length: 13 }, (_, i) => previewNode(i + 1))
    nodes[0] = previewNode(1, { ci: { id: 'ci-1', name: 'node-1', type: null }, role: 'mystery' })
    apolloFinto.risposte['GetServiceMapCreationPreview'] = { serviceMapCreationPreview: { serviceName: 'Enterprise Billing', nodes } }
    const { user } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    const section = await previewSection()
    await waitFor(() => expect(within(section).getByText('The map would have 13 components:')).toBeInTheDocument())
    const items = within(section).getAllByRole('listitem')
    expect(items).toHaveLength(12)
    // A node with no type shows a dash, an unknown role is named as unknown rather than dropped.
    expect(items[0]).toHaveTextContent('node-1 · — · level 1 · Unknown (mystery)')
    expect(within(section).getByText('and 1 more')).toBeInTheDocument()
    // Sorted relationship types: the preview is the same build as the creation.
    expect(apolloFinto.chiamata('GetServiceMapCreationPreview')).toEqual({ serviceId: 'ba-1', maxDepth: 4, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON', 'RUNS_ON'] })
  })

  it('an empty map is announced before it is created', async () => {
    apolloFinto.risposte['GetServiceMapCreationPreview'] = { serviceMapCreationPreview: { serviceName: 'Intranet', nodes: [] } }
    const { user } = open()
    await user.selectOptions(serviceSelect(), 'ba-2')
    expect(await screen.findByText(/With these settings the map would be empty/)).toBeInTheDocument()
  })

  it('a preview failure is an alert', async () => {
    apolloFinto.erroriQuery['GetServiceMapCreationPreview'] = new Error('too deep')
    const { user } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    expect(await screen.findByText('The preview could not be built: too deep')).toHaveAttribute('role', 'alert')
  })

  it('without an answer yet it says it is looking', async () => {
    delete apolloFinto.risposte['GetServiceMapCreationPreview']
    const { user } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    expect(await screen.findByText('Looking for the components…')).toBeInTheDocument()
  })
})

describe('creation', () => {
  it('success: toast, the list is told, the dialog closes and the new map opens', async () => {
    apolloFinto.esiti['CreateServiceMap'] = { data: { createServiceMap: { id: 'map-9', name: 'Enterprise Billing' } } }
    const { user, onClose, onCreated } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    await user.click(createButton())
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    await attendiURL('/monitoring/services/map-9')
    expect(toast.success).toHaveBeenCalledWith('Map of "Enterprise Billing" created')
    expect(onCreated).toHaveBeenCalledWith({ id: 'map-9', name: 'Enterprise Billing' })
    expect(onClose).toHaveBeenCalled()
    expect(apolloFinto.chiamata('CreateServiceMap')).toEqual({ serviceId: 'ba-1', maxDepth: 4, relationshipTypes: TENANT_RELS, status: 'active' })
  })

  it('an answer without the map is an error, and the dialog stays open', async () => {
    apolloFinto.esiti['CreateServiceMap'] = { data: { createServiceMap: null } }
    const { user, onClose } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    await user.click(createButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: createServiceMap did not return the map'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a server refusal is shown with its message', async () => {
    apolloFinto.esiti['CreateServiceMap'] = { error: new Error('already mapped') }
    const { user, onClose } = open()
    await user.selectOptions(serviceSelect(), 'ba-1')
    await user.click(createButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: already mapped'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('submitting without a service does not call the server', async () => {
    const { user } = open()
    // The form can still be submitted with Enter from the search box.
    await user.type(screen.getByLabelText('Search an application'), 'x{Enter}')
    expect(apolloFinto.chiamata('CreateServiceMap')).toBeUndefined()
  })
})
