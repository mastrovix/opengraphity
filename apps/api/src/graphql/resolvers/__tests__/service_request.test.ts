/**
 * The service request resolvers beyond creation, assignment and CI linking
 * (those have their own files): the list with its filters and sort, the edit,
 * the correction of a form answer, and the service catalog administration.
 *
 * Why these contracts matter to a user:
 *  - every read and write is scoped to the caller's tenant: a missing
 *    `tenant_id` would show (or change) another customer's requests;
 *  - an advanced filter must be ANDed to the fixed conditions — interpolated
 *    bare it made the Cypher invalid and the whole Requests page failed;
 *  - a sort on an unknown column is an error, never a silently different order;
 *  - clearing a description or a due date must really clear it (coalesce made
 *    "null" and "absent" the same, so a wrong date could never be removed);
 *  - correcting a form answer is audited WITH the values, including the answers
 *    the correction switched off, or a wrong correction cannot be undone;
 *  - a catalog item must point at an active service_request workflow with an
 *    initial step, or every request from it fails at the requester's desk;
 *  - from the portal only active catalog items exist, whatever the client asks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError, type GraphQLResolveInfo } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const h = vi.hoisted(() => ({ session: { tag: 'session' } }))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...orig, withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)) }
})
vi.mock('../../../lib/ciTypeFromLabels.js', () => ({ ciTypeFromLabels: vi.fn((_t: string, l: string[]) => l[0]!.toLowerCase()) }))
vi.mock('../../../services/requestService.js', () => ({
  createRequest: vi.fn(),
  mapRequest:    vi.fn((p: Record<string, unknown>) => p),
}))
vi.mock('../../../services/ticketAssignment.js', () => ({ setTicketUser: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/domainMatrix.js', () => import('../../../lib/__tests__/domainMatrixFake.js'))
vi.mock('../../../lib/validateRequiredFields.js', () => ({ validateRequiredFields: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/ticketUpdated.js', () => ({ publishTicketUpdated: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../ticketCustomFields.js', () => ({ requestCustomFieldDefs: vi.fn(async () => [{ name: 'cost_center' }]) }))
vi.mock('../../../lib/schemaFields.js', () => ({ getScalarFields: vi.fn(() => ['title', 'status', 'priority']) }))
vi.mock('../../../lib/catalogForm.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/catalogForm.js')>()
  return { ...orig, formFields: vi.fn(async () => []), writeFormAnswer: vi.fn().mockResolvedValue(undefined) }
})

const { serviceRequestResolvers } = await import('../service_request.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createRequest } = await import('../../../services/requestService.js')
const { audit } = await import('../../../lib/audit.js')
const { setTicketUser } = await import('../../../services/ticketAssignment.js')
const { publishTicketUpdated } = await import('../../../lib/ticketUpdated.js')
const { formFields, writeFormAnswer } = await import('../../../lib/catalogForm.js')

const { Query, Mutation } = serviceRequestResolvers
const operator: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }
const portalUser: GraphQLContext = { tenantId: 't1', userId: 'u2', userEmail: 'e@x', role: 'end_user', permissions: perms('end_user') }
const viewer: GraphQLContext = { tenantId: 't1', userId: 'u3', userEmail: 'v@x', role: 'viewer', permissions: perms('viewer') }
const admin: GraphQLContext = { tenantId: 't1', userId: 'u4', userEmail: 'a@x', role: 'admin', permissions: perms('admin') }
const info = { schema: {} } as unknown as GraphQLResolveInfo

async function failure(promise: Promise<unknown>): Promise<GraphQLError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  return err as GraphQLError
}

const libraryField = (name: string, fieldType: string, extra: Record<string, unknown> = {}) =>
  ({ id: name, name, fieldType, label: name, labels: [], help: null, helps: [], required: false, vocabulary: null, validationScript: null, formula: null, tableDefinition: null, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockResolvedValue([])
  vi.mocked(runQueryOne).mockResolvedValue(null)
  vi.mocked(formFields).mockResolvedValue([])
})

// ── serviceRequests ──────────────────────────────────────────────────────────

describe('serviceRequests — the Requests list', () => {
  it('reads the tenant only, with default page and order, and returns the total', async () => {
    vi.mocked(runQuery)
      .mockResolvedValueOnce([{ props: { id: 'sr-1' } }, { props: { id: 'sr-2' } }])
      .mockResolvedValueOnce([{ total: 7 }])
    const out = await Query.serviceRequests(null, {}, operator, info)
    expect(out).toEqual({ items: [{ id: 'sr-1' }, { id: 'sr-2' }], total: 7 })
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (r:ServiceRequest {tenant_id: $tenantId})')
    expect(cypher).toContain('ORDER BY r.created_at DESC')
    expect(params).toMatchObject({ tenantId: 't1', status: null, priority: null, offset: 0, limit: 20 })
  })

  it('a missing count row is a total of 0, not NaN', async () => {
    const out = await Query.serviceRequests(null, {}, operator, info)
    expect(out.total).toBe(0)
  })

  it('status, priority and sort reach the query; the count uses the same WHERE', async () => {
    await Query.serviceRequests(null, { status: 'new', priority: 'high', sortField: 'number', sortDirection: 'asc', limit: 5, offset: 10 }, operator, info)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('ORDER BY r.number ASC')
    expect(params).toMatchObject({ status: 'new', priority: 'high', limit: 5, offset: 10 })
    // the count must filter exactly like the page, or "3 of 40" lies
    expect(vi.mocked(runQuery).mock.calls[1]![1]).toContain('($status   IS NULL OR r.status   = $status)')
  })

  it('an unknown sort column is refused, naming the sortable ones', async () => {
    const err = await failure(Query.serviceRequests(null, { sortField: 'secret' }, operator, info))
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.sort.unknownField' })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('an advanced filter is ANDed to the fixed conditions (B-1), for product and customer fields', async () => {
    const filters = JSON.stringify({ rules: [
      { field: 'title', operator: 'contains', value: 'vpn', logic: 'AND' },
      { field: 'cost_center', operator: 'equals', value: 'CC1', logic: 'AND' },
    ] })
    await Query.serviceRequests(null, { filters }, operator, info)
    const cypher = vi.mocked(runQuery).mock.calls[0]![1]
    expect(cypher).toMatch(/AND \(\(?.*r\.title/s)
    expect(cypher).toContain('r.cost_center = $af_1')
  })

  it('a field outside the allowed set is refused, not dropped (a dropped rule widens the list)', async () => {
    const filters = JSON.stringify({ rules: [{ field: 'password', operator: 'equals', value: 'x', logic: 'AND' }] })
    await expect(Query.serviceRequests(null, { filters }, operator, info)).rejects.toThrow(/not allowed/)
  })

  it('library fields are filterable: references by the NAME of the node, tables by row, lists with list operators only', async () => {
    vi.mocked(formFields).mockResolvedValue([
      libraryField('owner', 'ref_user'),
      libraryField('people', 'table', { tableDefinition: { columns: [{ name: 'role' }] } }),
      libraryField('apps', 'multi_enum'),
      libraryField('env', 'enum'),
    ] as never)
    const filters = JSON.stringify({ rules: [
      { field: 'owner', operator: 'contains', value: 'Mario', logic: 'AND' },
      { field: 'people__role', operator: 'equals', value: 'admin', logic: 'AND' },
      { field: 'apps', operator: 'has_any', value: ['a'], logic: 'AND' },
      { field: 'env', operator: 'equals', value: 'prod', logic: 'AND' },
    ] })
    await Query.serviceRequests(null, { filters }, operator, info)
    const cypher = vi.mocked(runQuery).mock.calls[0]![1]
    expect(cypher).toContain('FORM_REFERS_TO_USER')
    expect(cypher).toContain('FORM_TABLE_ROW')
    // a text operator on a multi-choice field would generate invalid Cypher: refused with a message
    const bad = JSON.stringify({ rules: [{ field: 'apps', operator: 'contains', value: 'a', logic: 'AND' }] })
    const err = await failure(Query.serviceRequests(null, { filters: bad }, operator, info))
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.filter.operatorForList' })
  })
})

describe('serviceRequest — one request', () => {
  it('found in the tenant → mapped; not found → null', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'sr-1' } })
    expect(await Query.serviceRequest(null, { id: 'sr-1' }, operator)).toEqual({ id: 'sr-1' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'sr-1', tenantId: 't1' })
    expect(await Query.serviceRequest(null, { id: 'sr-x' }, operator)).toBeNull()
  })
})

// ── createServiceRequest (the parts the dedicated file does not reach) ────────

describe('createServiceRequest — form answers and SLA acknowledgement', () => {
  beforeEach(() => { vi.mocked(createRequest).mockResolvedValue({ id: 'sr-9' } as never) })

  it('table rows arrive as named cells and reach the service as flat maps; plain answers pass untouched', async () => {
    await Mutation.createServiceRequest(null, { input: { title: 'T', priority: 'low', formAnswers: [
      { name: 'env', value: 'prod' },
      { name: 'people', rows: [{ cells: [{ column: 'name', value: 'Ada' }, { column: 'role' }] }] },
    ] } }, operator)
    const sent = vi.mocked(createRequest).mock.calls[0]![0] as { formAnswers: unknown }
    // a missing cell value is null, not undefined: undefined would vanish on the node
    expect(sent.formAnswers).toEqual([
      { name: 'env', value: 'prod' },
      { name: 'people', rows: [{ name: 'Ada', role: null }] },
    ])
    expect(audit).toHaveBeenCalledWith(operator, 'request.created', 'ServiceRequest', 'sr-9')
  })

  it('a blank priority is refused for a request that does not come from the catalog', async () => {
    const err = await failure(Mutation.createServiceRequest(null, { input: { title: 'T', priority: '  ' } }, operator))
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.serviceRequest.priorityRequired' })
    expect(createRequest).not.toHaveBeenCalled()
  })

  it('a portal user cannot acknowledge "no SLA": it would hide a coverage gap from the admin', async () => {
    const err = await failure(Mutation.createServiceRequest(null, { input: { title: 'T', priority: 'low', acknowledgeNoSla: true } }, portalUser))
    expect(err.extensions['code']).toBe('FORBIDDEN')
    expect(createRequest).not.toHaveBeenCalled()
  })

  it('the catalog item workflow is passed on, the requester does not choose it', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ requiresApproval: null, priority: 'medium', name: 'VPN', category: null, workflowDefinitionId: 'wd-1', active: true })
    await Mutation.createServiceRequest(null, { input: { title: 'T', catalogItemId: 'cat-1' } }, operator)
    const sent = vi.mocked(createRequest).mock.calls[0]![0] as Record<string, unknown>
    expect(sent).toMatchObject({ workflowDefinitionId: 'wd-1', priority: 'medium', requiresApproval: false })
    expect(sent).not.toHaveProperty('category')
  })
})

// ── updateServiceRequest ─────────────────────────────────────────────────────

describe('updateServiceRequest', () => {
  it('distinguishes "cleared" from "not sent" for description and due date (B-17)', async () => {
    vi.mocked(runQuery)
      .mockResolvedValueOnce([{ props: { id: 'sr-1', description: 'old' } }])
      .mockResolvedValueOnce([{ props: { id: 'sr-1', description: null } }])
    const out = await Mutation.updateServiceRequest(null, { id: 'sr-1', input: { description: undefined as unknown as string } }, operator)
    const params = vi.mocked(runQuery).mock.calls[1]![2] as Record<string, unknown>
    expect(params).toMatchObject({ id: 'sr-1', tenantId: 't1', descriptionGiven: true, dueDateGiven: false, description: null, title: null })
    expect(out).toEqual({ id: 'sr-1', description: null })
    expect(audit).toHaveBeenCalledWith(operator, 'request.updated', 'ServiceRequest', 'sr-1')
    // subscribers get before and after, so they can tell what changed
    expect(publishTicketUpdated).toHaveBeenCalledWith(operator, 'service_request', 'sr-1', { id: 'sr-1', description: 'old' }, { id: 'sr-1', description: null })
  })

  it('the priority is checked against the dictionary before anything is read', async () => {
    const err = await failure(Mutation.updateServiceRequest(null, { id: 'sr-1', input: { priority: 'urgentissimo' } }, operator))
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.vocabulary.outOfVocabulary' })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('a valid priority is written', async () => {
    vi.mocked(runQuery)
      .mockResolvedValueOnce([{ props: { id: 'sr-1' } }])
      .mockResolvedValueOnce([{ props: { id: 'sr-1', priority: 'high' } }])
    await Mutation.updateServiceRequest(null, { id: 'sr-1', input: { priority: 'high', title: 'New', dueDate: '2026-10-01' } }, operator)
    expect(vi.mocked(runQuery).mock.calls[1]![2]).toMatchObject({ priority: 'high', title: 'New', dueDate: '2026-10-01', dueDateGiven: true })
  })

  it('a request of another tenant (or missing) is NOT_FOUND and nothing is written', async () => {
    const err = await failure(Mutation.updateServiceRequest(null, { id: 'sr-x', input: { title: 'x' } }, operator))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(publishTicketUpdated).not.toHaveBeenCalled()
  })

  it('a request deleted between the read and the write is NOT_FOUND, not a null result', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'sr-1' } }]).mockResolvedValueOnce([])
    const err = await failure(Mutation.updateServiceRequest(null, { id: 'sr-1', input: { title: 'x' } }, operator))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(audit).not.toHaveBeenCalled()
  })
})

// ── setServiceRequestFormAnswer ──────────────────────────────────────────────

describe('setServiceRequestFormAnswer — correcting an answer', () => {
  it('needs request.write: a viewer cannot change the data of a request', async () => {
    await expect(Mutation.setServiceRequestFormAnswer(null, { requestId: 'sr-1', field: 'env', value: 'prod' }, viewer))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(writeFormAnswer).not.toHaveBeenCalled()
  })

  it('writes through the shared rules and audits old and new values, plus the answers it cleared', async () => {
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ props: { id: 'sr-1', env: 'test', vpn: true, apps: ['a', 'b'], size: 3, note: null } })
      .mockResolvedValueOnce({ props: { id: 'sr-1', env: 'prod', vpn: null, apps: null, size: 3, note: null } })
    const out = await Mutation.setServiceRequestFormAnswer(null, { requestId: 'sr-1', field: 'env', value: 'prod' }, operator)
    expect(writeFormAnswer).toHaveBeenCalledWith(h.session, 't1', 'sr-1', 'env', 'prod')
    expect(audit).toHaveBeenCalledWith(operator, 'request.formAnswerChanged', 'ServiceRequest', 'sr-1', {
      field: 'env', from: 'test', to: 'prod',
      // lists are written comma-separated, booleans as text: readable in the Audit Log
      cleared: [{ field: 'vpn', from: 'true' }, { field: 'apps', from: 'a, b' }],
    })
    expect(publishTicketUpdated).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ env: 'prod' })
  })

  it('an answer emptied without side effects records from → null and no "cleared" list', async () => {
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ props: { id: 'sr-1' } })
      .mockResolvedValueOnce({ props: { id: 'sr-1' } })
    await Mutation.setServiceRequestFormAnswer(null, { requestId: 'sr-1', field: 'env' }, operator)
    expect(writeFormAnswer).toHaveBeenCalledWith(h.session, 't1', 'sr-1', 'env', null)
    expect(vi.mocked(audit).mock.calls[0]![4]).toEqual({ field: 'env', from: null, to: null })
  })

  it('a request that is not there (before or after the write) is NOT_FOUND', async () => {
    const err = await failure(Mutation.setServiceRequestFormAnswer(null, { requestId: 'sr-x', field: 'env', value: 'x' }, operator))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(writeFormAnswer).not.toHaveBeenCalled()

    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'sr-1' } }).mockResolvedValueOnce(null)
    const err2 = await failure(Mutation.setServiceRequestFormAnswer(null, { requestId: 'sr-1', field: 'env', value: 'x' }, operator))
    expect(err2.extensions['code']).toBe('NOT_FOUND')
    expect(audit).not.toHaveBeenCalled()
  })
})

// ── assignServiceRequestToUser: the re-read after the write ──────────────────

describe('assignServiceRequestToUser — request gone after the write', () => {
  it('is NOT_FOUND instead of returning null for a non-null field', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ completedAt: null, assigneeRole: null, assigneeFound: false }).mockResolvedValueOnce(null)
    const err = await failure(Mutation.assignServiceRequestToUser(null, { id: 'sr-1', userId: null }, operator))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(setTicketUser).toHaveBeenCalledTimes(1)
  })
})

// ── Field resolvers ──────────────────────────────────────────────────────────

describe('ServiceRequest field resolvers', () => {
  const fields = serviceRequestResolvers.ServiceRequest

  it('requestedBy and assignee follow the edge within the tenant, null when absent', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'u9', name: 'Ada', email: 'a@x' } })
    const by = await fields.requestedBy({ id: 'sr-1' }, null, operator) as { id: string } | null
    expect(by?.id).toBe('u9')
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).toContain('[:REQUESTED_BY]')
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'sr-1', tenantId: 't1' })
    expect(await fields.requestedBy({ id: 'sr-1' }, null, operator)).toBeNull()

    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'u8', name: 'Bob', email: 'b@x' } })
    const to = await fields.assignee({ id: 'sr-1' }, null, operator) as { id: string } | null
    expect(to?.id).toBe('u8')
    expect(vi.mocked(runQueryOne).mock.calls[2]![1]).toContain('[:ASSIGNED_TO]')
    expect(await fields.assignee({ id: 'sr-1' }, null, operator)).toBeNull()
  })

  it('affectedCIs: CIs of the tenant, typed from their label so the client can render each kind', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'fw-1', name: 'edge' }, label: 'Firewall' }])
    const cis = await fields.affectedCIs({ id: 'sr-1' }, null, operator) as Array<Record<string, unknown>>
    expect(cis[0]).toMatchObject({ id: 'fw-1', ciType: 'firewall', __typename: 'Firewall' })
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('[:CONCERNS_CI]')
    expect(cypher).toContain('ci.tenant_id = $tenantId')
    expect(params).toEqual({ id: 'sr-1', tenantId: 't1' })
  })
})

describe('removeCIFromServiceRequest — success and missing request', () => {
  it('removes the link and audits it', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'sr-1' }, removed: 1 })
    await Mutation.removeCIFromServiceRequest(null, { requestId: 'sr-1', ciId: 'fw-1' }, operator)
    expect(audit).toHaveBeenCalledWith(operator, 'request.ci_removed', 'ServiceRequest', 'sr-1', { ciId: 'fw-1' })
  })

  it('a request that is not in the tenant is NOT_FOUND', async () => {
    const err = await failure(Mutation.removeCIFromServiceRequest(null, { requestId: 'sr-x', ciId: 'fw-1' }, operator))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(audit).not.toHaveBeenCalled()
  })
})

// ── Service catalog ──────────────────────────────────────────────────────────

describe('serviceCatalogItems', () => {
  it('from the portal only active items, even when the client does not ask', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'c1', name: 'VPN', created_at: 'x' } }])
    const items = await Query.serviceCatalogItems(null, {}, portalUser)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toContain('WHERE ci.active = true')
    // defaults for items written before these fields existed
    expect(items[0]).toMatchObject({ id: 'c1', requiresApproval: false, active: true, priority: null, category: null, workflowDefinitionId: null })
  })

  it('staff see inactive items too unless they ask for active only', async () => {
    await Query.serviceCatalogItems(null, {}, operator)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).not.toContain('ci.active = true')
    await Query.serviceCatalogItems(null, { activeOnly: true }, operator)
    expect(vi.mocked(runQuery).mock.calls[1]![1]).toContain('WHERE ci.active = true')
    expect(vi.mocked(runQuery).mock.calls[1]![2]).toEqual({ tenantId: 't1' })
  })
})

describe('createServiceCatalogItem', () => {
  const created = { props: { id: 'c1', name: 'VPN', priority: 'high', active: true, created_at: 'x' } }

  it('needs config.catalog', async () => {
    await expect(Mutation.createServiceCatalogItem(null, { input: { name: 'VPN', priority: 'high' } }, operator))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('creates in the tenant with validated priority and category, empty category = none', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([created])
    const out = await Mutation.createServiceCatalogItem(null, { input: { name: 'VPN', priority: 'high', category: 'network' } }, admin)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ tenantId: 't1', name: 'VPN', priority: 'high', category: 'network', requiresApproval: false, description: null, workflowDefinitionId: null })
    expect(out).toMatchObject({ id: 'c1', name: 'VPN' })
    expect(vi.mocked(audit).mock.calls[0]![1]).toBe('service_catalog_item.created')

    vi.mocked(runQuery).mockResolvedValueOnce([created])
    await Mutation.createServiceCatalogItem(null, { input: { name: 'VPN', priority: 'high', category: '' } }, admin)
    expect(vi.mocked(runQuery).mock.calls[1]![2]).toMatchObject({ category: null })
  })

  it('a priority or category outside the dictionary is refused before writing', async () => {
    await expect(Mutation.createServiceCatalogItem(null, { input: { name: 'VPN', priority: 'p0' } }, admin)).rejects.toThrow(/not in the dictionary/)
    await expect(Mutation.createServiceCatalogItem(null, { input: { name: 'VPN', priority: 'high', category: 'food' } }, admin)).rejects.toThrow(/not in the dictionary/)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('a chosen workflow must exist, be active, be for service requests and have an initial step', async () => {
    const input = { name: 'VPN', priority: 'high', workflowDefinitionId: 'wd-1' }
    // not found / inactive
    vi.mocked(runQuery).mockResolvedValueOnce([])
    expect((await failure(Mutation.createServiceCatalogItem(null, { input }, admin))).extensions['i18n'])
      .toMatchObject({ key: 'errors.serviceCatalog.workflowNotFound' })
    // wrong entity type
    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'Inc flow', entityType: 'incident', iniziali: 1 }])
    expect((await failure(Mutation.createServiceCatalogItem(null, { input }, admin))).extensions['i18n'])
      .toMatchObject({ key: 'errors.serviceCatalog.workflowWrongType', params: { name: 'Inc flow', entityType: 'incident' } })
    // no initial step
    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'SR flow', entityType: 'service_request', iniziali: 0 }])
    expect((await failure(Mutation.createServiceCatalogItem(null, { input }, admin))).extensions['i18n'])
      .toMatchObject({ key: 'errors.serviceCatalog.workflowNoInitialStep' })
    expect(audit).not.toHaveBeenCalled()
    // the workflow lookup is scoped to the tenant and to active definitions
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('{id: $definitionId, tenant_id: $tenantId, active: true}')
    expect(params).toEqual({ definitionId: 'wd-1', tenantId: 't1' })
    // valid → created with it
    vi.mocked(runQuery)
      .mockResolvedValueOnce([{ name: 'SR flow', entityType: 'service_request', iniziali: 1 }])
      .mockResolvedValueOnce([created])
    await Mutation.createServiceCatalogItem(null, { input: { ...input, requiresApproval: true, description: 'd' } }, admin)
    expect(vi.mocked(runQuery).mock.calls[4]![2]).toMatchObject({ workflowDefinitionId: 'wd-1', requiresApproval: true, description: 'd' })
  })
})

describe('updateServiceCatalogItem', () => {
  const row = { props: { id: 'c1', name: 'VPN', created_at: 'x' } }

  it('needs config.catalog', async () => {
    await expect(Mutation.updateServiceCatalogItem(null, { id: 'c1', input: { name: 'x' } }, operator))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
  })

  it('writes only the fields that were sent; a new category closes the legacy free-text one', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([row])
    await Mutation.updateServiceCatalogItem(null, { id: 'c1', input: { name: 'VPN 2', description: 'd', category: 'network', requiresApproval: true, active: false, priority: 'low' } }, admin)
    const params = vi.mocked(runQuery).mock.calls[0]![2] as { sets: Record<string, unknown>; tenantId: string }
    expect(params.tenantId).toBe('t1')
    expect(params.sets).toEqual({ name: 'VPN 2', description: 'd', category: 'network', legacy_category: null, requires_approval: true, active: false, priority: 'low' })
    expect(vi.mocked(audit).mock.calls[0]![1]).toBe('service_catalog_item.updated')
  })

  it('an empty category clears it; a null workflow goes back to "by category" without validation', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([row])
    await Mutation.updateServiceCatalogItem(null, { id: 'c1', input: { category: '', workflowDefinitionId: null } }, admin)
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect((vi.mocked(runQuery).mock.calls[0]![2] as { sets: unknown }).sets).toEqual({ category: null, legacy_category: null, workflow_definition_id: null })

    vi.mocked(runQuery).mockResolvedValueOnce([row])
    await Mutation.updateServiceCatalogItem(null, { id: 'c1', input: { workflowDefinitionId: '' } }, admin)
    expect((vi.mocked(runQuery).mock.calls[1]![2] as { sets: unknown }).sets).toEqual({ workflow_definition_id: null })
  })

  it('a workflow set on update is validated too (an inactive one was accepted before)', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([])
    const err = await failure(Mutation.updateServiceCatalogItem(null, { id: 'c1', input: { workflowDefinitionId: 'wd-off' } }, admin))
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.serviceCatalog.workflowNotFound' })
    expect(runQuery).toHaveBeenCalledTimes(1)

    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'SR', entityType: 'service_request', iniziali: 2 }]).mockResolvedValueOnce([row])
    await Mutation.updateServiceCatalogItem(null, { id: 'c1', input: { workflowDefinitionId: 'wd-1' } }, admin)
    expect((vi.mocked(runQuery).mock.calls[2]![2] as { sets: unknown }).sets).toEqual({ workflow_definition_id: 'wd-1' })
  })

  it('the priority can be changed but not removed', async () => {
    for (const priority of [null, '  ']) {
      const err = await failure(Mutation.updateServiceCatalogItem(null, { id: 'c1', input: { priority } }, admin))
      expect(err.extensions['i18n']).toMatchObject({ key: 'errors.serviceRequest.catalogItemPriorityRequired' })
    }
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('nothing to update is an error, not a silent no-op', async () => {
    const err = await failure(Mutation.updateServiceCatalogItem(null, { id: 'c1', input: {} }, admin))
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.nothingToUpdate' })
  })

  it('an item that is not in the tenant is NOT_FOUND', async () => {
    const err = await failure(Mutation.updateServiceCatalogItem(null, { id: 'c-x', input: { name: 'x' } }, admin))
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('ServiceCatalogItem.workflowDefinitionName', () => {
  const resolve = serviceRequestResolvers.ServiceCatalogItem.workflowDefinitionName

  it('no workflow → null without touching the database', async () => {
    expect(await resolve({ workflowDefinitionId: null }, null, operator)).toBeNull()
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('reads the name in the tenant; a deleted definition is null', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ name: 'Access flow' }])
    expect(await resolve({ workflowDefinitionId: 'wd-1' }, null, operator)).toBe('Access flow')
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ definitionId: 'wd-1', tenantId: 't1' })
    expect(await resolve({ workflowDefinitionId: 'wd-gone' }, null, operator)).toBeNull()
  })
})
