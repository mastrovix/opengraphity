/**
 * THE CI DETAIL PAGE: EDITING A CI, ITS GROUPS AND ITS RELATIONS.
 *
 * This is where the CMDB is kept true by hand. What must not regress:
 *  - saving sends ONLY what changed, base fields as themselves and the
 *    type-specific ones inside `customFields`: sending everything would
 *    overwrite a field someone else changed meanwhile;
 *  - a relation is created in the direction the METAMODEL declares (an
 *    incoming relation has this CI as target), one option per declared type:
 *    a reversed edge turns the impact analysis upside down;
 *  - removing a relation removes the right edge (source/target as stored);
 *  - a dynamic CI group shows its members, says when the server truncated the
 *    list, and draws a capped graph the administrator can raise.
 *
 * `CIDetailPage.test.tsx` covers the wire (MockedProvider, the dynamic query
 * text) and the health section; this file covers behaviour through the fake
 * Apollo. The heavy children (graph, incident/change cards, attachments,
 * health, services, criteria builder) have their own tests and are stubs here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { MetamodelContext, type CITypeDef } from '@/contexts/MetamodelContext'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'

vi.mock('@apollo/client/react', async () => {
  const m = (await import('@/test/apolloFinto')).moduloApollo()
  type Opts = { onCompleted?: (d: unknown, o?: unknown) => void; [k: string]: unknown }
  return {
    ...m,
    // Real Apollo hands `onCompleted` the call's options as second argument,
    // and the page reads `variables.teamId` from it to pick the toast
    // ("updated" vs "removed"). The shared fake does not, so forward them here.
    useMutation: (doc: Parameters<typeof m.useMutation>[0], opts: Opts = {}) => {
      const [fnAny, r] = m.useMutation(doc, opts)
      const fn = fnAny as unknown as (o: Opts) => Promise<unknown>
      const call = (o: Opts = {}) => fn({ ...o, onCompleted: opts.onCompleted && ((d: unknown) => opts.onCompleted!(d, o)) })
      return [call, r] as const
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))

vi.mock('@/components/CIGraph', () => ({
  CIGraph: ({ dependencies, dependents, blastRadius }: { dependencies: unknown[]; dependents: unknown[]; blastRadius: unknown[] }) =>
    <div data-testid="ci-graph">{`deps:${dependencies.length} dependents:${dependents.length} blast:${blastRadius.length}`}</div>,
}))
vi.mock('@/components/CIIncidentsCard', () => ({ CIIncidentsCard: () => null }))
vi.mock('@/components/CIChangeList', () => ({ CIChangeList: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))
vi.mock('./CIHealthSection', () => ({ CIHealthSection: () => null }))
vi.mock('./CIServicesSection', () => ({ CIServicesSection: () => null }))
vi.mock('./GroupCriteriaBuilder', () => ({
  GroupCriteriaBuilder: ({ criteria, onSaved }: { criteria: Record<string, string>; onSaved: () => void }) =>
    <div data-testid="criteria">{JSON.stringify(criteria)}<button type="button" onClick={onSaved}>save criteria</button></div>,
}))

const { CIDetailPage } = await import('./CIDetailPage')

// ── Metamodel ────────────────────────────────────────────────────────────────

const field = (name: string, order: number, extra: Partial<CITypeDef['fields'][number]> = {}) => ({
  id: `f-${name}`, name, label: name.toUpperCase(), fieldType: 'string', required: false, enumValues: [] as string[], order,
  isSystem: false, validationScript: null, visibilityScript: null, defaultScript: null, ...extra,
})
const baseType = (over: Partial<CITypeDef>): CITypeDef => ({
  id: 'ct', name: 'server', label: 'Server', icon: 'server', color: '#000', active: true, scope: 'base', tenantId: 'system',
  validationScript: null, chainFamilies: [], serviceRole: null, fields: [], relations: [], systemRelations: [], ...over,
})
const SERVER = baseType({
  fields: [
    field('status', 1, { enumValues: ['active', 'retired'], isSystem: true }),
    field('environment', 2, { enumValues: ['production', 'staging'], enumTypeName: 'environment', isSystem: true }),
    field('ip_address', 4),
    field('tier', 3, { enumValues: ['gold', 'silver'], enumTypeName: 'server_tier' }),
  ],
  relations: [
    // Two relation types in ONE metamodel relation: each must be its own option (#56).
    { id: 'r1', name: 'runsOn', label: 'Runs on', relationshipType: 'DEPENDS_ON | HOSTED_ON', targetType: 'server', cardinality: 'many', direction: 'outgoing', order: 1 },
    { id: 'r2', name: 'usedBy', label: 'Used by', relationshipType: 'USES', targetType: 'application', cardinality: 'many', direction: 'incoming', order: 2 },
    // A duplicate declaration must not produce a second identical option.
    { id: 'r3', name: 'runsOn2', label: 'Runs on again', relationshipType: 'HOSTED_ON', targetType: 'server', cardinality: 'many', direction: 'outgoing', order: 3 },
  ],
})
const GROUP = baseType({ id: 'ct-g', name: 'dynamic_ci_group', label: 'Dynamic group', icon: 'layers' })
const BARE = baseType({ id: 'ct-b', name: 'rack', label: 'Rack', icon: 'box' })

const VOCAB: DomainVocabularies = {
  valuesOf: () => null,
  labelOf: (name: string, value: string) => ({ 'environment:production': 'Production', 'server_tier:gold': 'Gold tier' } as Record<string, string>)[`${name}:${value}`] ?? null,
  colorOf: () => null, entriesOf: () => null, vocabularyLabelOf: () => null, loading: false, error: null,
} as unknown as DomainVocabularies

function Metamodel({ children, loading = false, error = null }: { children: ReactNode; loading?: boolean; error?: Error | null }) {
  const types = [SERVER, GROUP, BARE]
  return (
    <MetamodelContext.Provider value={{ ciTypes: types, loading, error, getCIType: (n: string) => types.find((t) => t.name === n) }}>
      <DomainVocabularyContext.Provider value={VOCAB}>{children}</DomainVocabularyContext.Provider>
    </MetamodelContext.Provider>
  )
}

// ── Data ─────────────────────────────────────────────────────────────────────

const ref = (id: string, name: string, type = 'server') => ({ id, name, type, environment: 'production', status: 'active' })
const SRV = {
  id: 'srv-1', name: 'web-01', type: 'server', status: 'active', environment: 'production', description: 'Front end',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', notes: null,
  ownerGroup: { id: 'tm-1', name: 'Ops' }, supportGroup: null,
  dependencies: [{ relation: 'DEPENDS_ON', ci: ref('db-1', 'db-prod') }],
  dependents: [{ relation: 'USES', ci: { ...ref('app-1', 'crm-app', 'application'), status: null } }],
  ip_address: '10.0.0.7', tier: 'gold',
}

beforeEach(() => {
  apolloFinto.reset()
  Object.values(toast).forEach((f) => f.mockReset())
  apolloFinto.risposte['DynamicDetail_Server'] = { server: SRV }
  apolloFinto.risposte['GetTeams'] = { teams: [{ id: 'tm-1', name: 'Ops' }, { id: 'tm-2', name: 'Network' }] }
  apolloFinto.risposte['GetBlastRadius'] = { blastRadius: [{ distance: 1, parentId: 'srv-1', ci: ref('x-1', 'lb') }] }
})

type MetaOpts = { loading?: boolean; error?: Error | null }
const show = (route = '/ci/server/srv-1', meta: MetaOpts = {}) =>
  renderWithProviders(<Metamodel {...meta}><CIDetailPage /></Metamodel>, { route, path: '/ci/:typeName/:id' })
const location = () => screen.getByTestId('location').textContent
const card = (name: RegExp) => screen.getByRole('button', { name })
async function openCard(user: ReturnType<typeof show>['user'], name: RegExp) {
  const c = card(name)
  if (c.getAttribute('aria-expanded') === 'false') await user.click(c)
}

describe('page states', () => {
  it('shows loading while the metamodel loads, and its error when it fails', () => {
    const { unmount } = show(undefined, { loading: true })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    unmount()
    show(undefined, { error: new Error('metamodel down') })
    expect(screen.getByText('metamodel down')).toBeInTheDocument()
  })

  it('a failed detail query offers a retry', async () => {
    apolloFinto.erroriQuery['DynamicDetail_Server'] = new Error('neo4j unavailable')
    const { user } = show()
    expect(screen.getByText('neo4j unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('reads values with their vocabulary labels, and the back link returns to the type list', async () => {
    const { user } = show()
    expect(screen.getByRole('heading', { level: 1, name: 'web-01' })).toBeInTheDocument()
    // "Production" and "Gold tier", not the internal production / gold.
    expect(screen.getByText('Production')).toBeInTheDocument()
    expect(screen.getByText('Gold tier')).toBeInTheDocument()
    expect(screen.getByText('10.0.0.7')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Server' }))
    await waitFor(() => expect(location()).toBe('/ci/server'))
  })

  it('a CI with no relations says so, and its dependency map draws its blast radius', async () => {
    apolloFinto.risposte['DynamicDetail_Server'] = { server: { ...SRV, dependencies: [], dependents: [], status: null, environment: null, updatedAt: null } }
    const { user } = show()
    await openCard(user, /^Relationships \(0\)/)
    expect(screen.getByText('No relationships.')).toBeInTheDocument()
    await openCard(user, /^Dependency Map/)
    expect(await screen.findByTestId('ci-graph')).toHaveTextContent('deps:0 dependents:0 blast:1')
  })
})

describe('editing', () => {
  it('saves only what changed: base fields as themselves, type fields inside customFields', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const name = screen.getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'web-01b')
    // The enum options show the vocabulary label, the value stays internal.
    const tier = screen.getByLabelText('TIER')
    expect(within(tier).getByRole('option', { name: 'Gold tier' })).toHaveValue('gold')
    await user.selectOptions(tier, 'silver')
    await user.selectOptions(screen.getByLabelText('Status'), 'retired')
    await user.selectOptions(screen.getByLabelText('Environment'), 'staging')
    await user.type(screen.getByLabelText('Notes'), 'n')
    const descr = screen.getByLabelText('Description')
    await user.clear(descr)
    await user.type(descr, 'Edge')
    const ip = screen.getByLabelText('IP_ADDRESS')
    await user.clear(ip)
    await user.type(ip, '10.0.0.7') // typed back to the original: not a change
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apolloFinto.chiamata('UpdateCI')).toEqual({ id: 'srv-1', input: {
      name: 'web-01b', status: 'retired', environment: 'staging', description: 'Edge', notes: 'n',
      customFields: JSON.stringify({ tier: 'silver' }),
    } }))
    expect(toast.success).toHaveBeenCalledWith('Changes saved')
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('without changes Save just closes the form; a base-only change sends no customFields', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateCI')).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateCI')).toEqual({ id: 'srv-1', input: { name: 'web-01x' } }))
  })

  it('a refused save keeps the form open and shows the reason', async () => {
    apolloFinto.esiti['UpdateCI'] = { error: new Error('name already used') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('name already used'))
    expect(screen.getByLabelText('Name')).toHaveValue('web-01x')
  })
})

describe('owner and support groups', () => {
  it('assigning says "updated", choosing "not assigned" says "removed" and sends null', async () => {
    const { user } = show()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Support Group' }), 'tm-2')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Support group updated'))
    expect(apolloFinto.chiamata('AssignCISupportGroup')).toEqual({ ciId: 'srv-1', teamId: 'tm-2' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Owner Group' }), '')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Owner group removed'))
    // null, not '': the API removes the edge only on null.
    expect(apolloFinto.chiamata('AssignCIOwner')).toEqual({ ciId: 'srv-1', teamId: null })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Owner Group' }), 'tm-2')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Owner group updated'))

    apolloFinto.esiti['AssignCISupportGroup'] = { data: {} }
    await user.selectOptions(screen.getByRole('combobox', { name: 'Support Group' }), '')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Support group removed'))
  })

  it('a refused assignment is shown', async () => {
    apolloFinto.esiti['AssignCIOwner'] = { error: new Error('owner required') }
    apolloFinto.esiti['AssignCISupportGroup'] = { error: new Error('team archived') }
    const { user } = show()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Owner Group' }), 'tm-2')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('owner required'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Support Group' }), 'tm-1')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('team archived'))
  })
})

describe('relations', () => {
  it('an outgoing relation has this CI as source; the search needs two letters and hides this CI', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [ref('srv-1', 'web-01'), ref('db-9', 'db-new')] } }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Add relation' }))
    const d = screen.getByRole('dialog', { name: 'Add relation — web-01' })
    const type = within(d).getByLabelText('Relation type')
    // One option per declared type, duplicates collapsed, direction from the metamodel.
    expect(within(type).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Runs on: DEPENDS ON (This CI → ...)', 'Runs on: HOSTED ON (This CI → ...)', 'Used by: USES (... → This CI)',
    ])
    await user.selectOptions(type, 'outgoing:HOSTED_ON')
    const add = within(d).getByRole('button', { name: 'Add relation' })
    expect(add).toBeDisabled()

    await user.type(within(d).getByLabelText('Target CI'), 'd')
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined() // one letter matches half the CMDB
    await user.type(within(d).getByLabelText('Target CI'), 'b')
    expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ search: 'db', limit: 10 })
    // A CI cannot be related to itself: it is not offered.
    expect(within(d).queryByRole('button', { name: /web-01 \(/ })).not.toBeInTheDocument()
    await user.click(within(d).getByRole('button', { name: /db-new/ }))
    expect(within(d).getByLabelText('Target CI')).toHaveValue('db-new')
    await user.click(add)

    await waitFor(() => expect(apolloFinto.chiamata('AddCIRelationship')).toEqual({ sourceId: 'srv-1', targetId: 'db-9', relationType: 'HOSTED_ON' }))
    expect(toast.success).toHaveBeenCalledWith('Relation added')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('an incoming relation has this CI as target; clearing the target disables Add; a refusal keeps the dialog', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [ref('app-7', 'billing', 'application')] } }
    apolloFinto.esiti['AddCIRelationship'] = { error: new Error('cardinality exceeded') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Add relation' }))
    const d = screen.getByRole('dialog')
    await user.selectOptions(within(d).getByLabelText('Relation type'), 'incoming:USES')
    await user.type(within(d).getByLabelText('Target CI'), 'bi')
    await user.click(within(d).getByRole('button', { name: /billing/ }))
    await user.click(within(d).getByRole('button', { name: 'Delete' })) // clear the chosen target
    expect(within(d).getByRole('button', { name: 'Add relation' })).toBeDisabled()
    await user.click(within(d).getByRole('button', { name: /billing/ }))
    await user.click(within(d).getByRole('button', { name: 'Add relation' }))
    await waitFor(() => expect(apolloFinto.chiamata('AddCIRelationship')).toEqual({ sourceId: 'app-7', targetId: 'srv-1', relationType: 'USES' }))
    expect(toast.error).toHaveBeenCalledWith('cardinality exceeded')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // Cancel resets the form: reopening starts from the first metamodel option, empty.
    await user.click(within(d).getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Add relation' }))
    expect(within(screen.getByRole('dialog')).getByLabelText('Relation type')).toHaveValue('outgoing:DEPENDS_ON')
    expect(within(screen.getByRole('dialog')).getByLabelText('Target CI')).toHaveValue('')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a type without declared relations says so instead of offering a hard-coded one', async () => {
    apolloFinto.risposte['DynamicDetail_Rack'] = { rack: { ...SRV, id: 'rk-1', name: 'rack-A', type: 'rack', dependencies: [], dependents: [] } }
    const { user } = show('/ci/rack/rk-1')
    await user.click(screen.getByRole('button', { name: 'Add relation' }))
    expect(screen.getByText('This CI type declares no relation in the metamodel.')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add relation' })).toBeDisabled()
  })

  it('removing asks first and removes the stored edge in its own direction', async () => {
    const { user } = show()
    await openCard(user, /^Relationships \(2\)/)
    await user.click(screen.getByRole('button', { name: /DEPENDS ON/ }))
    await user.click(screen.getByRole('button', { name: /USES/ }))

    await user.click(within(screen.getByRole('button', { name: /db-prod/ })).getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('Remove DEPENDS_ON relation with db-prod?')).toBeInTheDocument()
    expect(location()).toBe('/ci/server/srv-1') // the delete button does not open the related CI
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Remove DEPENDS_ON/)).not.toBeInTheDocument()

    // A dependent is stored as (other) → (this CI).
    await user.click(within(screen.getByRole('button', { name: /crm-app/ })).getByRole('button', { name: 'Delete' }))
    const bar = screen.getByText('Remove USES relation with crm-app?').parentElement!
    await user.click(within(bar).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('RemoveCIRelationship')).toEqual({ sourceId: 'app-1', targetId: 'srv-1', relationType: 'USES' }))
    expect(toast.success).toHaveBeenCalledWith('Relation removed')
    expect(screen.queryByText(/Remove USES/)).not.toBeInTheDocument()

    apolloFinto.esiti['RemoveCIRelationship'] = { error: new Error('edge locked') }
    await user.click(within(screen.getByRole('button', { name: /db-prod/ })).getByRole('button', { name: 'Delete' }))
    const bar2 = screen.getByText('Remove DEPENDS_ON relation with db-prod?').parentElement!
    await user.click(within(bar2).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('RemoveCIRelationship')).toEqual({ sourceId: 'srv-1', targetId: 'db-1', relationType: 'DEPENDS_ON' }))
    expect(toast.error).toHaveBeenCalledWith('edge locked')
    expect(screen.getByText(/Remove DEPENDS_ON/)).toBeInTheDocument()
  })

  it('only dependents: no separator, the list still shows', async () => {
    apolloFinto.risposte['DynamicDetail_Server'] = { server: { ...SRV, dependencies: [] } }
    const { user } = show()
    await openCard(user, /^Relationships \(1\)/)
    expect(screen.getByText('Dependents')).toBeInTheDocument()
    expect(screen.queryByText('Dependencies')).not.toBeInTheDocument()
  })
})

describe('dynamic CI group', () => {
  const member = (i: number) => ({ id: `m-${i}`, name: `member-${String(i).padStart(3, '0')}`, type: i === 0 ? '' : 'server', environment: 'production', status: i === 1 ? null : 'active' })
  const GROUP_CI = {
    id: 'g-1', name: 'All web', type: 'dynamic_ci_group', status: 'active', environment: null, description: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: null, notes: 'n', ownerGroup: null, supportGroup: null,
    dependencies: [], dependents: [], membershipType: 'dynamic', criteriaCiTypes: 'server', criteriaEnvironment: null,
    criteriaStatus: 'active', criteriaNameContains: 'web',
  }

  it('lists members page by page, opens a member, and saving criteria reloads them', async () => {
    apolloFinto.risposte['DynamicDetail_DynamicCiGroup'] = { dynamic_ci_group: GROUP_CI }
    apolloFinto.risposte['CiGroupMembers'] = { ciGroupMembers: { items: Array.from({ length: 30 }, (_, i) => member(i)), total: 30, truncated: false } }
    const { user } = show('/ci/dynamic_ci_group/g-1')
    expect(screen.getByRole('button', { name: /^Members \(30\)/ })).toBeInTheDocument()
    expect(screen.getByTestId('criteria')).toHaveTextContent('"environment":""')
    expect(screen.getByText('member-000')).toBeInTheDocument()
    expect(screen.queryByText('member-025')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    expect(screen.getByText('member-025')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    expect(screen.getByText('member-000')).toBeInTheDocument()

    // The map is about the members: open by default, drawn from them, no blast radius.
    expect(screen.getByTestId('ci-graph')).toHaveTextContent('deps:30 dependents:0 blast:0')
    expect(screen.queryByLabelText('Nodes:')).not.toBeInTheDocument() // under the cap nothing to choose

    const before = apolloFinto.refetch.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'save criteria' }))
    expect(apolloFinto.refetch.mock.calls.length).toBeGreaterThan(before)

    await user.click(screen.getByText('member-002'))
    await waitFor(() => expect(location()).toBe('/ci/server/m-2'))
  })

  it('says when the server truncated the list, and the graph cap can be raised', async () => {
    apolloFinto.risposte['DynamicDetail_DynamicCiGroup'] = { dynamic_ci_group: { ...GROUP_CI, membershipType: 'manual' } }
    apolloFinto.risposte['CiGroupMembers'] = { ciGroupMembers: { items: Array.from({ length: 120 }, (_, i) => member(i)), total: 900, truncated: true } }
    const { user } = show('/ci/dynamic_ci_group/g-1')
    // "120 of 900", never a false "120".
    expect(screen.getByRole('button', { name: /^Members \(120 of 900\)/ })).toBeInTheDocument()
    expect(screen.getByText(/List truncated: the server returns at most 120 of 900 members/)).toBeInTheDocument()
    expect(screen.queryByTestId('criteria')).not.toBeInTheDocument() // manual group: no criteria

    expect(screen.getByTestId('ci-graph')).toHaveTextContent('deps:50')
    expect(screen.getByText(/Showing the first 50 of 120 members/)).toBeInTheDocument()
    const cap = screen.getByLabelText('Nodes:')
    // 50 and 100 are below 120, 200 is the first above it; 500 would be the same as "all".
    expect(within(cap).getAllByRole('option').map((o) => o.textContent)).toEqual(['50', '100', '200', 'All (120)'])
    await user.selectOptions(cap, '120')
    expect(screen.getByTestId('ci-graph')).toHaveTextContent('deps:120')
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument()
  })

  it('an empty group says it has no members', async () => {
    apolloFinto.risposte['DynamicDetail_DynamicCiGroup'] = { dynamic_ci_group: GROUP_CI }
    apolloFinto.risposte['CiGroupMembers'] = { ciGroupMembers: { items: [], total: 0, truncated: false } }
    show('/ci/dynamic_ci_group/g-1')
    expect(screen.getByText('No members.')).toBeInTheDocument()
  })
})
