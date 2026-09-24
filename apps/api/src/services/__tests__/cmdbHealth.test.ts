/**
 * CMDB HEALTH (24 Sep 2026): the live data-quality checks of the CMDB.
 *
 * What these pin:
 *  - which types each check looks at comes from the tenant's metamodel —
 *    chain families, service role, required fields — and from the CMDB chains
 *    the tenant drew, never from type names;
 *  - «outside every chain» and «incomplete chain» come from the walk of the
 *    chains (cmdbChains/evaluate.ts, its own tests); «relation not admitted»
 *    compares every relation with what the chains admit;
 *  - retired CIs are left out, except for the expired-certificate check, where
 *    `expired` is itself a retired status and is exactly what to find;
 *  - every query is tenant-scoped and receives labels, fields and statuses as
 *    parameters (no interpolated Cypher);
 *  - an unknown check or type is refused, not answered with «no results».
 * The queries themselves run on a real Neo4j in the integration suite (every
 * read without required arguments is executed there, `cmdbHealth` included).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const session = { close: vi.fn().mockResolvedValue(undefined) }
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => session),
  runQuery: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('@opengraphity/schema-generator', () => ({ loadMetamodel: vi.fn() }))
vi.mock('../../lib/ciMetamodelForTenant.js', () => ({ serviceRolesForTenant: vi.fn() }))
vi.mock('../../lib/ciLifecycle.js', () => ({ resolveCILifecycleSemantics: vi.fn() }))
vi.mock('../../lib/mappers.js', () => ({ toSnakeCase: (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) }))
vi.mock('../cmdbChains/store.js', () => ({ listChains: vi.fn() }))
vi.mock('../cmdbChains/evaluate.js', () => ({ evaluateChains: vi.fn() }))

const { runQuery } = await import('@opengraphity/neo4j')
const { loadMetamodel } = await import('@opengraphity/schema-generator')
const { serviceRolesForTenant } = await import('../../lib/ciMetamodelForTenant.js')
const { resolveCILifecycleSemantics } = await import('../../lib/ciLifecycle.js')
const { listChains } = await import('../cmdbChains/store.js')
const { evaluateChains } = await import('../cmdbChains/evaluate.js')
const { healthContext, runHealthCheck, cmdbHealthSummary, cmdbHealthItems, assertHealthCheck, CMDB_HEALTH_CHECKS } = await import('../cmdbHealth.js')

const field = (name: string, label: string, required = false) => ({ name, label, required, fieldType: 'string' })
const GROUPS = [{ name: 'ownerGroup' }, { name: 'supportGroup' }]
const type = (name: string, neo4jLabel: string, chainFamilies: string[], fields: ReturnType<typeof field>[] = [], systemRelations = GROUPS) =>
  ({ name, neo4jLabel, chainFamilies, fields, systemRelations })
const TYPES = [
  type('application', 'Application', ['Application']),
  type('business_application', 'BusinessApplication', ['Application']),
  // No Support Group: the type does not declare it (24 Sep 2026).
  type('business_capability', 'BusinessCapability', ['Application'], [], [{ name: 'ownerGroup' }]),
  type('server', 'Server', ['Application', 'Infrastructure'], [field('serialNumber', 'Serial number', true), field('notes', 'Notes')]),
  type('certificate', 'Certificate', ['Application', 'Infrastructure'], [field('expiresAt', 'Expires at', true), field('serialNumber', 'Serial', true)]),
  // A certificate type of the customer's, with no expiry field: it cannot be checked, and it is named.
  type('vpn_token', 'VpnToken', ['Infrastructure'], []),
  type('network_zone', 'NetworkZone', ['Infrastructure']),
]
/** One chain: a business application realizes applications, which stand on servers (required). */
const CHAIN = {
  id: 'ch1', name: 'Application services', kind: 'application', createdAt: null, updatedAt: null,
  nodes: [
    { id: 'ba', parentId: null, ciType: 'business_application', relationType: null, direction: null, required: true },
    { id: 'app', parentId: 'ba', ciType: 'application', relationType: 'REALIZES', direction: 'outgoing', required: true },
    { id: 'srv', parentId: 'app', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true },
  ],
}
const WALK = {
  drawnLabels: ['BusinessApplication', 'Application', 'Server'],
  reached: new Set(['ba1', 'app1', 'srv1']),
  incomplete: new Map([['app2', [{ chain: 'Application services', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing' }]]]),
  checkedForLinks: new Set(['ba1', 'app1', 'app2']),
  coverage: [{ chainId: 'ch1', name: 'Application services', kind: 'application', roots: 1, complete: 0 }],
}
/** A row as the walked checks read it. */
const ciRow = (id: string, name: string, label: string) => ({ id, name, labels: ['ConfigurationItem', label], environment: 'production', status: 'active' })
const ROLES = new Map([['Application', 'component'], ['BusinessApplication', 'component'], ['BusinessCapability', 'component'], ['Server', 'infrastructure'], ['Certificate', 'certificate'], ['VpnToken', 'certificate'], ['NetworkZone', 'infrastructure']])

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadMetamodel).mockResolvedValue(TYPES as never)
  vi.mocked(serviceRolesForTenant).mockResolvedValue(ROLES as never)
  vi.mocked(resolveCILifecycleSemantics).mockResolvedValue({ retired: new Set(['decommissioned', 'expired']), maintenance: new Set(), ignored: new Set() })
  vi.mocked(runQuery).mockResolvedValue([{ population: 0, total: 0, items: [] }] as never)
  vi.mocked(listChains).mockResolvedValue([CHAIN] as never)
  vi.mocked(evaluateChains).mockResolvedValue(WALK as never)
})

describe('healthContext: what each check looks at comes from the metamodel', () => {
  it('application = only Application, certificate = its service role, required = the fields; the chains and what they admit', async () => {
    const ctx = await healthContext('t1', session as never)
    expect(ctx.applicationLabels).toEqual(['Application', 'BusinessApplication', 'BusinessCapability'])
    // Only the types that declare a group can miss it: a capability has no Support Group.
    expect(ctx.supportGroupLabels).not.toContain('BusinessCapability')
    expect(ctx.ownerGroupLabels).toContain('BusinessCapability')
    expect(ctx.certificateLabels).toEqual(['Certificate', 'VpnToken'])
    expect(ctx.expiryByLabel).toEqual({ Certificate: 'expires_at' })
    expect(ctx.certificateTypesWithoutExpiry).toEqual(['vpn_token'])
    expect(ctx.requiredByLabel).toEqual({ Server: ['serial_number'], Certificate: ['expires_at', 'serial_number'] })
    expect(ctx.retired).toEqual(['decommissioned', 'expired'])
    expect(listChains).toHaveBeenCalledWith(session, 't1')
    expect(ctx.typeLabels).toEqual(['Application', 'BusinessApplication', 'BusinessCapability', 'Server', 'Certificate', 'VpnToken', 'NetworkZone'])
    // The chain's links, as `Source|RELATION|Target`.
    expect(ctx.admitted).toEqual(['BusinessApplication|REALIZES|Application', 'Application|HOSTED_ON|Server'])
    expect(ctx.drawnLabels).toEqual(['BusinessApplication', 'Application', 'Server'])
  })
})

describe('runHealthCheck', () => {
  it('passes labels, statuses and filters as parameters; a type name becomes its label; the page is clamped', async () => {
    const ctx = await healthContext('t1', session as never)
    await runHealthCheck(session as never, ctx, 'missing_owner_group', { type: 'server', environment: 'production', limit: 99_999, offset: -5 })
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (ci:ConfigurationItem {tenant_id: $tenantId})')
    expect(cypher).toContain('NOT coalesce(ci.status, \'\') IN $retired')
    expect(cypher).not.toContain('${')
    expect(params).toMatchObject({
      tenantId: 't1', type: 'Server', environment: 'production', limit: 10_000, offset: 0,
      retired: ['decommissioned', 'expired'], admitted: ['BusinessApplication|REALIZES|Application', 'Application|HOSTED_ON|Server'],
    })
  })

  it('no filter is null, not an empty string: the query reads «IS NULL»', async () => {
    const ctx = await healthContext('t1', session as never)
    await runHealthCheck(session as never, ctx, 'missing_owner_group', { environment: '' })
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ type: null, environment: null, limit: 50, offset: 0 })
  })

  it('maps a row: the type name from the label, the missing properties back to the field labels, numbers as numbers', async () => {
    const ctx = await healthContext('t1', session as never)
    vi.mocked(runQuery).mockResolvedValueOnce([{ population: 12, total: 1, items: [
      { id: 'c1', name: 'CER_x', labels: ['ConfigurationItem', 'Certificate'], environment: 'production', status: 'expired',
        expiresAt: '2026-04-01T00:00:00Z', inUseBy: 3, missing: ['serial_number', 'expires_at'] },
    ] }] as never)
    const page = await runHealthCheck(session as never, ctx, 'required_field_empty')
    expect(page).toEqual({ population: 12, total: 1, items: [{
      id: 'c1', name: 'CER_x', type: 'certificate', environment: 'production', status: 'expired',
      expiresAt: '2026-04-01T00:00:00Z', inUseBy: 3, sameName: null,
      // In the type's order, by their labels.
      missingFields: ['Expires at', 'Serial'],
      missingLinks: [], relation: null, relatedId: null, relatedName: null, relatedType: null,
    }] })
  })

  it('an unknown type is refused, not answered with «no results»', async () => {
    const ctx = await healthContext('t1', session as never)
    await expect(runHealthCheck(session as never, ctx, 'chain_orphan', { type: 'toaster' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(runQuery).not.toHaveBeenCalled()
    expect(evaluateChains).not.toHaveBeenCalled()
  })

  it('a query that answers no row is an error, not a healthy CMDB', async () => {
    const ctx = await healthContext('t1', session as never)
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(runHealthCheck(session as never, ctx, 'duplicate_name')).rejects.toThrow(/returned no row/)
  })
})

describe('the queries of each check', () => {
  const cypherOf = async (check: (typeof CMDB_HEALTH_CHECKS)[number]) => {
    const ctx = await healthContext('t1', session as never)
    await runHealthCheck(session as never, ctx, check)
    return vi.mocked(runQuery).mock.calls.at(-1)![1] as string
  }

  it('each is tenant-scoped and literal', async () => {
    for (const check of CMDB_HEALTH_CHECKS.filter((c) => c !== 'chain_orphan' && c !== 'chain_incomplete')) {
      const cypher = await cypherOf(check)
      expect(cypher, check).toContain('{tenant_id: $tenantId}')
      expect(cypher, check).not.toContain('${')
      expect(cypher, check).toContain('AS population')
    }
  })

  it('what each looks for', async () => {
    // A relation between two CIs in service whose `Source|RELATION|Target` no chain admits.
    expect(await cypherOf('relation_not_admitted')).toContain("NOT coalesce(a.status, '') IN $retired AND NOT coalesce(b.status, '') IN $retired")
    expect(await cypherOf('relation_not_admitted')).toContain("fromLabel + '|' + type(r) + '|' + toLabel AS key")
    expect(await cypherOf('relation_not_admitted')).toContain('NOT key IN $admitted')
    // Only between types some chain draws: a dynamic group and its members are outside the chains.
    expect(await cypherOf('relation_not_admitted')).toContain('WHERE fromLabel IN $drawnLabels AND toLabel IN $drawnLabels')
    expect(await cypherOf('missing_owner_group')).toContain('NOT EXISTS { MATCH (ci)-[:OWNED_BY]->(:Team {tenant_id: $tenantId}) }')
    expect(await cypherOf('missing_support_group')).toContain('NOT EXISTS { MATCH (ci)-[:SUPPORTED_BY]->(:Team {tenant_id: $tenantId}) }')
    expect(await cypherOf('missing_support_group')).toContain('any(l IN labels(ci) WHERE l IN $supportGroupLabels)')
    expect(await cypherOf('missing_owner_group')).toContain('any(l IN labels(ci) WHERE l IN $ownerGroupLabels)')
    expect(await cypherOf('certificate_unrelated')).toContain('NOT EXISTS { MATCH (ci)--(o:ConfigurationItem) WHERE o.tenant_id = $tenantId }')
    expect(await cypherOf('application_without_cis')).toContain('NOT EXISTS { MATCH (ci)-->(o:ConfigurationItem) WHERE o.tenant_id = $tenantId }')
    expect(await cypherOf('duplicate_name')).toContain('toLower(trim(coalesce(ci.name, \'\'))) AS nameKey')
    expect(await cypherOf('required_field_empty')).toContain('ci[f] IS NULL OR trim(toString(ci[f])) = \'\'')
  })

  it('an expired certificate is looked at whatever its status; only the CIs using it must be in service', async () => {
    const cypher = await cypherOf('certificate_expired_in_use')
    expect(cypher).not.toContain('NOT coalesce(ci.status, \'\') IN $retired')
    expect(cypher).toContain('NOT coalesce(o.status, \'\') IN $retired')
    expect(cypher).toContain('expiresAt < $now AND inUseBy > 0')
  })
})

describe('the checks the walk of the chains answers', () => {
  it('outside every chain: the CIs in service of the drawn types, flagged infrastructure aside, that no chain reaches', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([ciRow('app1', 'APP_a', 'Application'), ciRow('srv9', 'SRV_lost', 'Server'), ciRow('srv1', 'SRV_b', 'Server')] as never)
    const ctx = await healthContext('t1', session as never)
    const page = await runHealthCheck(session as never, ctx, 'chain_orphan', { type: 'server', limit: 10 })
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('AND coalesce(ci.is_infrastructure, false) = false')
    expect(cypher).toContain("NOT coalesce(ci.status, '') IN $retired")
    expect(params).toMatchObject({ labels: WALK.drawnLabels, type: 'Server', environment: null })
    expect(page.population).toBe(3)
    expect(page.total).toBe(1)
    expect(page.items.map((i) => [i.id, i.type])).toEqual([['srv9', 'server']])
    expect(evaluateChains).toHaveBeenCalledWith(session, 't1', [CHAIN], TYPES, ['decommissioned', 'expired'])
  })

  it('incomplete chain: the CIs in service a required link applies to, looked up by id; each hit says which links it lacks', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([ciRow('app1', 'APP_a', 'Application'), ciRow('app2', 'APP_b', 'Application')] as never)
    const ctx = await healthContext('t1', session as never)
    const page = await runHealthCheck(session as never, ctx, 'chain_incomplete', { environment: 'production' })
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('UNWIND $ids AS cid')
    expect(params).toMatchObject({ ids: ['ba1', 'app1', 'app2'], environment: 'production', type: null })
    expect(page).toMatchObject({ population: 2, total: 1 })
    expect(page.items[0]).toMatchObject({ id: 'app2', type: 'application', missingLinks: WALK.incomplete.get('app2') })
  })

  it('the walk is done once per request, however many checks ask for it', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    const ctx = await healthContext('t1', session as never)
    await runHealthCheck(session as never, ctx, 'chain_orphan')
    await runHealthCheck(session as never, ctx, 'chain_incomplete')
    expect(evaluateChains).toHaveBeenCalledOnce()
  })

  it('a relation not admitted names the relation and the CI at its other end', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ population: 40, total: 1, items: [
      { id: 'db1', name: 'DB_x', labels: ['ConfigurationItem', 'Server'], environment: 'production', status: 'active',
        relation: 'USES_CERTIFICATE', relatedId: 'c1', relatedName: 'CER_y', relatedLabels: ['ConfigurationItem', 'Certificate'] },
    ] }] as never)
    const ctx = await healthContext('t1', session as never)
    const page = await runHealthCheck(session as never, ctx, 'relation_not_admitted')
    expect(page.items[0]).toMatchObject({ relation: 'USES_CERTIFICATE', relatedId: 'c1', relatedName: 'CER_y', relatedType: 'certificate' })
  })
})

describe('cmdbHealthSummary and cmdbHealthItems', () => {
  /** The literal checks answer a population row; the walked ones read CI rows. */
  const answer = (cypher: string) => (cypher.includes('AS population') ? [{ population: 10, total: 2, items: [] }] : [ciRow('srv9', 'SRV_lost', 'Server')])

  it('the summary counts every check with an empty page, names the certificate types it could not check, and gives each chain its coverage', async () => {
    vi.mocked(runQuery).mockImplementation((async (_s: unknown, cypher: string) => answer(cypher)) as never)
    const out = await cmdbHealthSummary('t1')
    expect(out.checks.map((c) => c.key)).toEqual([...CMDB_HEALTH_CHECKS])
    expect(vi.mocked(runQuery).mock.calls.filter(([, c]) => (c as string).includes('AS population')).every(([, , p]) => (p as { limit: number }).limit === 0)).toBe(true)
    expect(out.checks.find((c) => c.key === 'certificate_expired_in_use')!.notCheckedTypes).toEqual(['vpn_token'])
    expect(out.checks.find((c) => c.key === 'chain_orphan')).toEqual({ key: 'chain_orphan', count: 1, population: 1, notCheckedTypes: [], needsChains: false })
    expect(out.checks.find((c) => c.key === 'duplicate_name')).toEqual({ key: 'duplicate_name', count: 2, population: 10, notCheckedTypes: [], needsChains: false })
    expect(out.retiredStatuses).toEqual(['decommissioned', 'expired'])
    expect(out.chainCount).toBe(1)
    expect(out.chainCoverage).toEqual(WALK.coverage)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('with no chain drawn, the three chain checks say so — the others do not', async () => {
    vi.mocked(listChains).mockResolvedValue([] as never)
    vi.mocked(runQuery).mockImplementation((async (_s: unknown, cypher: string) => answer(cypher)) as never)
    const out = await cmdbHealthSummary('t1')
    expect(out.checks.filter((c) => c.needsChains).map((c) => c.key)).toEqual(['chain_orphan', 'chain_incomplete', 'relation_not_admitted'])
    expect(out.chainCount).toBe(0)
  })

  it('the items of one check, with the filters; an unknown check is refused before any query', async () => {
    await cmdbHealthItems('t1', 'duplicate_name', { limit: 10, offset: 20 })
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ limit: 10, offset: 20 })
    expect(session.close).toHaveBeenCalledOnce()
    await expect(cmdbHealthItems('t1', 'everything', {})).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.cmdbHealth.unknownCheck' } } })
    expect(() => assertHealthCheck(42)).toThrow(/Unknown CMDB health check/)
  })

  it('the session is closed even when a check fails', async () => {
    vi.mocked(runQuery).mockRejectedValueOnce(new Error('neo4j down'))
    await expect(cmdbHealthSummary('t1')).rejects.toThrow('neo4j down')
    expect(session.close).toHaveBeenCalledOnce()
  })
})
