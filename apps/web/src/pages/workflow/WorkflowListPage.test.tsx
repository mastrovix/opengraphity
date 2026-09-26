/**
 * THE LIST OF WORKFLOWS: one column per ticket type, one card per workflow,
 * and the way out for a tenant whose configuration is incomplete.
 *
 * What an administrator relies on:
 *  - the columns follow the process order (incident, change, problem,
 *    service request, KB article), named as the CUSTOMER names each type, and
 *    a type the page does not know still gets its column (the gap is logged,
 *    not hidden);
 *  - within a type the default workflow comes first, then the variants by
 *    category; each card says its version and whether it is active, and
 *    opens the designer;
 *  - while the list loads nothing claims "No workflows found";
 *  - a tenant with configuration gaps is told what is missing, and "Complete
 *    the configuration" fills the gaps and says whether anything is still
 *    missing. Before this button, the only remedy was a migration from the
 *    command line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within, fireEvent } from '@testing-library/react'
import { attendiURL, renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { WorkflowListPage } from './WorkflowListPage'

/* The fake Apollo of the page tests; a query named in `inCaricamento` is still loading. */
const inCaricamento = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  return {
    ...base,
    useQuery: (...args: Parameters<typeof base.useQuery>) => {
      const r = base.useQuery(...args)
      return inCaricamento.has(nomeOperazione(args[0])) ? { ...r, data: undefined, loading: true } : r
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const wf = (id: string, name: string, entityType: string, over: Record<string, unknown> = {}) => ({
  id, name, entityType, category: null as string | null, active: true, version: 1, ...over,
})

const NO_WORKFLOWS = { kind: 'no_workflows', params: [{ name: 'entityTypes', value: 'problem, change' }] }
const NO_TEAMS = { kind: 'no_teams', params: [] }

beforeEach(() => {
  apolloFinto.reset()
  inCaricamento.clear()
  toast.success.mockReset(); toast.error.mockReset(); toast.warning.mockReset()
  apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [] }
  apolloFinto.risposte['GetTenantProvisioningGaps'] = { tenantProvisioningGaps: [] }
  // The customer renamed "incident".
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [
    { name: 'incident', label: 'Disruption', fields: [] }, { name: 'change', label: 'Change', fields: [] },
    { name: 'problem', label: 'Problem', fields: [] }, { name: 'service_request', label: 'Service Request', fields: [] },
  ] }
})

/** The column of a type, found by its header. */
const column = (label: string) => screen.getByText(label, { selector: 'span' }).parentElement!.parentElement!
const cardNames = (col: HTMLElement) => within(col).getAllByRole('button').map((b) => b.querySelector('span')!.textContent)

describe('WorkflowListPage — the list', () => {
  it('while the list loads it shows a dash for the count, and never "No workflows found"', () => {
    inCaricamento.add('GetWorkflowList')
    renderWithProviders(<WorkflowListPage />)
    expect(screen.getByRole('heading', { name: 'Workflow' }).parentElement!.parentElement).toHaveTextContent('—')
    expect(screen.queryByText('No workflows found')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('without workflows it says so', () => {
    renderWithProviders(<WorkflowListPage />)
    expect(screen.getByText('0 workflows')).toBeInTheDocument()
    expect(screen.getByText('No workflows found')).toBeInTheDocument()
  })

  it('one column per type in process order, named as the customer names it, with its number of workflows', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [
      wf('w-kb', 'KB Article Lifecycle', 'kb_article'),
      wf('w-asset', 'Asset request', 'asset_request'),
      wf('w-chg', 'Change RFC Process', 'change'),
      wf('w-inc', 'Incident Management', 'incident'),
      wf('w-inc2', 'Security incidents', 'incident', { category: 'security' }),
      wf('w-sr', 'Service Request Fulfillment', 'service_request'),
      wf('w-prb', 'Problem Management', 'problem'),
    ] }
    renderWithProviders(<WorkflowListPage />)
    expect(screen.getByText('7 workflows')).toBeInTheDocument()
    const headers = ['Disruption', 'Change', 'Problem', 'Service Request', 'KB article', 'asset_request']
    const found = screen.getAllByText((_, el) => el?.tagName === 'SPAN' && headers.includes(el.textContent ?? ''))
    expect(found.map((el) => el.textContent)).toEqual(headers)
    expect(column('Disruption')).toHaveTextContent(/^Disruption2/)
    expect(column('KB article')).toHaveTextContent(/^KB article1/)
    // A type the page has no icon for keeps its column, and the gap is reported.
    expect(cardNames(column('asset_request'))).toEqual(['Asset request'])
    expect(logged).toHaveBeenCalledWith('[ENTITY_META] unknown value: "asset_request"')
  })

  it('within a type the default workflows come first, then the variants by category', () => {
    apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [
      wf('w2', 'Security incidents', 'incident', { category: 'security' }),
      wf('w3', 'Major incidents', 'incident', { category: 'major' }),
      wf('w1', 'Incident Management', 'incident'),
      wf('w4', 'Network incidents', 'incident', { category: 'network' }),
      wf('w5', 'Incident Management (copy)', 'incident'),
    ] }
    renderWithProviders(<WorkflowListPage />)
    const col = column('Disruption')
    expect(cardNames(col)).toEqual([
      'Incident Management', 'Incident Management (copy)', 'Major incidents', 'Network incidents', 'Security incidents',
    ])
    const cards = within(col).getAllByRole('button')
    expect(within(cards[0]!).getByText('Default')).toBeInTheDocument()
    expect(within(cards[1]!).getByText('Default')).toBeInTheDocument()
    expect(within(cards[2]!).getByText('major')).toBeInTheDocument()
    expect(within(cards[2]!).queryByText('Default')).toBeNull()
  })

  it('each card says its version and whether it is active, and opens the designer', async () => {
    apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [
      wf('w1', 'Incident Management', 'incident', { version: 3 }),
      wf('w2', 'Old incidents', 'incident', { category: 'legacy', active: false, version: 1 }),
    ] }
    const { user } = renderWithProviders(<WorkflowListPage />)
    const active = screen.getByRole('button', { name: /Incident Management/ })
    expect(active).toHaveTextContent('Active')
    expect(active).toHaveTextContent('v3')
    const old = screen.getByRole('button', { name: /Old incidents/ })
    expect(old).toHaveTextContent('Inactive')
    expect(old).toHaveTextContent('v1')
    await user.click(active)
    await attendiURL('/workflow/w1')
  })

  it('pointing at a card highlights it in the colour of its type, and leaving restores it', () => {
    apolloFinto.risposte['GetWorkflowList'] = { workflowDefinitions: [wf('w1', 'Incident Management', 'incident')] }
    renderWithProviders(<WorkflowListPage />)
    const card = screen.getByRole('button', { name: /Incident Management/ })
    fireEvent.mouseEnter(card)
    expect(card.style.borderColor).toBe('var(--color-danger)')
    expect(card.style.boxShadow).not.toBe('none')
    fireEvent.mouseLeave(card)
    expect(card.style.borderColor).toBe('var(--color-border)')
    expect(card.style.boxShadow).toBe('none')
  })
})

describe('WorkflowListPage — an incomplete configuration', () => {
  it('a tenant without gaps — or whose gaps have not been read yet — has no warning', () => {
    const { unmount } = renderWithProviders(<WorkflowListPage />)
    expect(screen.queryByText("This tenant's configuration is incomplete")).toBeNull()
    expect(screen.queryByRole('button', { name: 'Complete the configuration' })).toBeNull()
    unmount()
    delete apolloFinto.risposte['GetTenantProvisioningGaps']
    renderWithProviders(<WorkflowListPage />)
    expect(screen.queryByText("This tenant's configuration is incomplete")).toBeNull()
  })

  it('says what is missing; "Complete the configuration" fills it and says the tenant is usable', async () => {
    apolloFinto.risposte['GetTenantProvisioningGaps'] = { tenantProvisioningGaps: [NO_WORKFLOWS, NO_TEAMS] }
    apolloFinto.esiti['ProvisionTenantData'] = { data: { provisionTenantData: { remainingGaps: [] } } }
    const { user } = renderWithProviders(<WorkflowListPage />)
    const banner = screen.getByText("This tenant's configuration is incomplete").parentElement!
    expect(banner).toHaveTextContent(
      'no active workflow for: problem, change; no teams: without teams CIs have no Owner/Support Group and no change can be created (Organization & access → Teams)',
    )
    await user.click(screen.getByRole('button', { name: 'Complete the configuration' }))
    expect(apolloFinto.chiamate['ProvisionTenantData']).toHaveLength(1)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Configuration completed: the tenant is usable.'))
    // The gaps are read again.
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('when something is still missing afterwards, it says what', async () => {
    apolloFinto.risposte['GetTenantProvisioningGaps'] = { tenantProvisioningGaps: [NO_WORKFLOWS, NO_TEAMS] }
    apolloFinto.esiti['ProvisionTenantData'] = { data: { provisionTenantData: { remainingGaps: [NO_TEAMS] } } }
    const { user } = renderWithProviders(<WorkflowListPage />)
    await user.click(screen.getByRole('button', { name: 'Complete the configuration' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Configuration created, but this is still missing: no teams: without teams CIs have no Owner/Support Group and no change can be created (Organization & access → Teams)',
    ))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a failure is said', async () => {
    apolloFinto.risposte['GetTenantProvisioningGaps'] = { tenantProvisioningGaps: [NO_TEAMS] }
    apolloFinto.esiti['ProvisionTenantData'] = { error: new Error('provisioning is already running') }
    const { user } = renderWithProviders(<WorkflowListPage />)
    await user.click(screen.getByRole('button', { name: 'Complete the configuration' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('provisioning is already running'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
