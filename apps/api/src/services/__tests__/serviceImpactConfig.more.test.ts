/**
 * services/serviceImpact/config.ts — the edges of the map configuration the
 * main suite (serviceImpactConfig.test.ts) does not walk.
 *
 * Why these matter to an administrator:
 *  - malformed input from the client (null rules, a null component, an empty
 *    id, a non-list of relationship types) must be refused as BAD_USER_INPUT
 *    before anything is written — never a 500, never a half-applied change;
 *  - a map left incomplete by an old migration (no service_id, no
 *    relationship_types, a status outside the vocabulary) must fail with a
 *    message naming the migration, not a proposal built on guesses;
 *  - applying a proposal must never push a map over the 500-component cap;
 *  - the version-conflict message must stay readable when the map has no
 *    `updated_at` yet;
 *  - history notes name components by their id when they have no name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('../serviceImpact/sync.js', () => ({ syncServiceMap: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../events/policy.js', () => ({ getEventPolicy: vi.fn().mockResolvedValue({ suppress_upstream_hops: 1,
  retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'], ignore_lifecycle_statuses: ['decommissioned'] }) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../middleware/metrics.js', () => ({
  workflowPurposeMissingTotal: { inc: vi.fn() },
  serviceEvaluationsTotal: { inc: vi.fn() }, serviceEvaluationDurationSeconds: { observe: vi.fn() }, servicesHealth: { set: vi.fn() },
  eventsSuppressedTotal: { inc: vi.fn() },
}))
vi.mock('../serviceImpact/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../serviceImpact/engine.js')>()),
  evaluateServiceMap: vi.fn(),
}))
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:        vi.fn(async () => ['Application', 'Server', 'Database', 'Certificate', 'Storage']),
  apocLabelFilterForTenant: vi.fn(async () => '+Application|+Server|+Database|+Certificate|+Storage'),
}))
vi.mock('../../lib/ciMetamodelForTenant.js', () => ({
  serviceRelationshipTypesForTenant: vi.fn(async () => ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE']),
  suppressionRelPatternForTenant:    vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE'),
  serviceRolesForTenant:             vi.fn(async () => new Map([
    ['Application', 'component'], ['Server', 'infrastructure'], ['Database', 'infrastructure'],
    ['Certificate', 'certificate'], ['Storage', 'infrastructure'],
  ])),
}))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getStepNamesByPurpose: vi.fn(async (_s: unknown, _t: unknown, _e: unknown, purposes: readonly string[]) =>
    purposes.includes('implementation') ? ['deployment'] : ['scheduled']),
}))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { evaluateServiceMap } = await import('../serviceImpact/engine.js')
const {
  applyServiceMapProposal, assertServiceImpactRulesInput, assertServiceMapNodeInputs, previewServiceImpact,
  removeServiceMapExclusion, serviceMapProposal, setServiceMapAutoSync, updateServiceImpactRules, updateServiceMapNodes,
  updateServiceMapScope, serviceMapConflictMessage,
} = await import('../serviceImpact/config.js')
const { DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_MAP_MAX_NODES } = await import('../../lib/serviceVocabularies.js')

const NOW = '2026-09-22T10:00:00.000Z'
const tx = { run: vi.fn() }
const session = { close: vi.fn().mockResolvedValue(undefined), executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)), executeRead: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) }

function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of rules) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => { const r = await impl(s, c, p); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'no error thrown').toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

const LOAD_RE     = /MATCH \(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->/
const EXCL_RE     = /\[:EXCLUDES\]->\(ci \{tenant_id: \$tenantId\}\)/
const RULES_RE    = /SET m\.rules = \$rules/
const NODES_RE    = /SET inc\.propagate = n\.propagate/
const APPLY_RE    = /SET m\.node_ids = includedIds \+ \$keepMissing/
const UNEXCL_RE   = /MATCH \(m\)-\[e:EXCLUDES\]->\(ci \{id: \$ciId, tenant_id: \$tenantId\}\)/
const AUTOSYNC_RE = /SET m\.auto_sync = \$autoSync/
const SCOPE_RE    = /SET m\.relationship_types = \$relationshipTypes, m\.max_depth = toInteger\(\$maxDepth\)/

const n = (o: Record<string, unknown>) => ({ name: String(o['ciId']).toUpperCase(), labels: ['Server'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'operational', healthSource: 'monitoring', status: 'active', changes: [], ...o })
function stateRow(over: { props?: Record<string, unknown>; nodes?: Record<string, unknown>[] } = {}) {
  return {
    props: {
      id: 'map-1', tenant_id: 't1', service_id: 'ba-1', name: 'Billing', status: 'active', version: 2, updated_at: 'T-prev',
      max_depth: 4, relationship_types: ['DEPENDS_ON', 'HOSTED_ON'], rules: DEFAULT_SERVICE_IMPACT_RULES_JSON,
      health: 'operational', stale: false, auto_sync: true, synced_at: null, node_ids: ['api-03', 'db-01', 'old-99'], ...over.props,
    },
    nodes: over.nodes ?? [
      n({ ciId: 'api-03', labels: ['Application'], level: 1, role: 'entry', weight: 8, critical: true, via: null }),
      n({ ciId: 'db-01', labels: ['Database'] }),
      n({ ciId: 'old-99' }),
    ],
  }
}
const ENTRY_ROW = { serviceName: 'Billing', apps: [{ ciId: 'api-03', name: 'API-03', labels: ['Application'], status: 'active', health: 'operational' }] }
const base = { tenantId: 't1', mapId: 'map-1', expectedVersion: 2, actorId: 'u-1' }
const rulesInput = { downSharePct: 70, degradedSharePct: 10, minNodes: 1, unknownNodes: 'ignore', openIncidentFrom: 'down', duringStorm: 'hold' } as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(evaluateServiceMap).mockResolvedValue({ mapId: 'map-1', health: 'operational', previousHealth: 'operational', impactScore: 0, changed: false, stale: false, causes: [] } as never)
})

describe('input validation — malformed client input is BAD_USER_INPUT', () => {
  it('rules that are not an object', () => {
    expect(() => assertServiceImpactRulesInput(null as never, 3)).toThrow(/rules must be an object. Got: null/)
    expect(() => assertServiceImpactRulesInput('x' as never, 3)).toThrow(GraphQLError)
  })

  it('a component entry that is not an object', () => {
    expect(() => assertServiceMapNodeInputs([null as never])).toThrow(/nodes: null is not a component/)
  })

  it('an empty id in the proposal lists is refused before writing', async () => {
    onCypher([[LOAD_RE, stateRow()], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, []], [EXCL_RE, []]])
    await expectCode(applyServiceMapProposal({ ...base, add: [], exclude: [''], remove: [], now: NOW }), 'BAD_USER_INPUT', /exclude: "" is not an id/)
    expect(callMatching(APPLY_RE)).toBeUndefined()
  })

  it('relationshipTypes that is not a list', async () => {
    await expectCode(updateServiceMapScope({ ...base, relationshipTypes: 'DEPENDS_ON' as never, maxDepth: 4, now: NOW }), 'BAD_USER_INPUT', /relationshipTypes must be a list. Got: "DEPENDS_ON"/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('an empty ciId to re-admit', async () => {
    await expectCode(removeServiceMapExclusion({ ...base, ciId: '', now: NOW }), 'BAD_USER_INPUT', /ciId must be a non-empty id. Got: ""/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('several unknown components are named together, in the plural', async () => {
    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(updateServiceMapNodes({
      ...base, now: NOW,
      nodes: [{ ciId: 'x1', propagate: 'always', weight: 5, critical: false }, { ciId: 'x2', propagate: 'always', weight: 5, critical: false }],
    }), 'BAD_USER_INPUT', /nodes: x1, x2 are not components of ServiceMap map-1/)
    expect(callMatching(NODES_RE)).toBeUndefined()
  })
})

describe('version conflict message', () => {
  it('a map never updated says "n/a" instead of "null"', async () => {
    expect(serviceMapConflictMessage('map-1', 2, 3, null)).toContain('updated at n/a')
    onCypher([[LOAD_RE, stateRow({ props: { updated_at: null, version: 3 } })]])
    await expectCode(updateServiceImpactRules({ ...base, rules: rulesInput, now: NOW }), 'BAD_USER_INPUT', /expected version 2, current is 3, updated at n\/a/)
  })
})

describe('incomplete maps name the migration', () => {
  const withProposal = (props: Record<string, unknown>) =>
    onCypher([[LOAD_RE, stateRow({ props })], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, []], [EXCL_RE, []]])

  it('no service_id', async () => {
    withProposal({ service_id: null })
    await expect(serviceMapProposal('t1', 'map-1', NOW)).rejects.toThrow(/ServiceMap map-1 has no service_id — run the 20260910_1080_service_maps_bootstrap migration/)
  })

  it('no relationship_types (diff and scope update)', async () => {
    withProposal({ relationship_types: null })
    await expect(serviceMapProposal('t1', 'map-1', NOW)).rejects.toThrow(/ServiceMap map-1 has no relationship_types/)
    await expect(updateServiceMapScope({ ...base, relationshipTypes: ['DEPENDS_ON'], maxDepth: 3, now: NOW }))
      .rejects.toThrow(/ServiceMap map-1 has no relationship_types — run the 20260910_1080/)
    expect(callMatching(SCOPE_RE)).toBeUndefined()
  })

  it('a status outside the vocabulary', async () => {
    withProposal({ status: 'archived' })
    await expect(serviceMapProposal('t1', 'map-1', NOW)).rejects.toThrow(/ServiceMap map-1 status is "archived": expected one of/)
  })
})

describe('applyServiceMapProposal — the component cap', () => {
  it(`adding over ${SERVICE_MAP_MAX_NODES} components is refused before writing`, async () => {
    // Current map: the entry + 499 components, one of which (old-x) is no
    // longer reachable. Graph now: the entry + 498 of them + one new CI.
    const ids = Array.from({ length: SERVICE_MAP_MAX_NODES - 2 }, (_, i) => `c-${String(i).padStart(3, '0')}`)
    const nodes = [
      n({ ciId: 'api-03', labels: ['Application'], level: 1, role: 'entry', weight: 8, critical: true, via: null }),
      ...ids.map((ciId) => n({ ciId })),
      n({ ciId: 'old-x' }),
    ]
    const expanded = [...ids, 'new-1'].map((ciId) => ({ ciId, name: ciId, level: 2, via: 'api-03', labels: ['Server'], status: 'active', health: null }))
    onCypher([
      [LOAD_RE, stateRow({ props: { node_ids: nodes.map((x) => x['ciId']) }, nodes })],
      [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, expanded], [EXCL_RE, []],
    ])
    await expectCode(applyServiceMapProposal({ ...base, add: ['new-1'], exclude: [], remove: [], now: NOW }), 'BAD_USER_INPUT',
      new RegExp(`to ${SERVICE_MAP_MAX_NODES + 1} components, over the ${SERVICE_MAP_MAX_NODES} cap`))
    expect(callMatching(APPLY_RE)).toBeUndefined()
  })
})

describe('history notes fall back to the CI id', () => {
  it('a component without a name is listed by its id', async () => {
    onCypher([[LOAD_RE, stateRow({ nodes: [n({ ciId: 'api-03', name: '', labels: ['Application'], level: 1, role: 'entry', via: null })] })], [NODES_RE, { version: 3, status: 'active', updated: 1 }]])
    const r = await updateServiceMapNodes({ ...base, nodes: [{ ciId: 'api-03', propagate: 'never', weight: 4, critical: false }], now: NOW })
    expect(r.note).toContain('api-03')
  })

  it('a re-admitted exclusion without a name is named by its id', async () => {
    onCypher([[LOAD_RE, stateRow()], [EXCL_RE, [{ id: 'cert-x', name: '', labels: ['Certificate'], status: 'active', health: null }]], [UNEXCL_RE, { version: 3, status: 'active', removed: 1 }]])
    const r = await removeServiceMapExclusion({ ...base, ciId: 'cert-x', now: NOW })
    expect(r.note).toContain('cert-x')
  })
})

describe('writes without an explicit instant use the current time', () => {
  const isNow = (iso: unknown, before: number) => {
    const t = Date.parse(String(iso))
    return t >= before && t <= Date.now()
  }

  it('rules, nodes, auto-sync, scope and exclusion writes all stamp "now"', async () => {
    const before = Date.now()
    onCypher([[LOAD_RE, stateRow()], [RULES_RE, { version: 3, status: 'active' }]])
    await updateServiceImpactRules({ ...base, rules: rulesInput })
    expect(isNow(callMatching(RULES_RE)!.params['now'], before)).toBe(true)

    onCypher([[LOAD_RE, stateRow()], [NODES_RE, { version: 3, status: 'active', updated: 1 }]])
    await updateServiceMapNodes({ ...base, nodes: [{ ciId: 'db-01', propagate: 'never', weight: 4, critical: false }] })
    expect(isNow(callMatching(NODES_RE)!.params['now'], before)).toBe(true)

    onCypher([[LOAD_RE, stateRow()], [AUTOSYNC_RE, { version: 3, status: 'active' }]])
    await setServiceMapAutoSync({ ...base, autoSync: false })
    expect(isNow(callMatching(AUTOSYNC_RE)!.params['now'], before)).toBe(true)

    onCypher([[LOAD_RE, stateRow()], [SCOPE_RE, { version: 3, status: 'active', autoSync: false }]])
    await updateServiceMapScope({ ...base, relationshipTypes: ['DEPENDS_ON'], maxDepth: 4 })
    expect(isNow(callMatching(SCOPE_RE)!.params['now'], before)).toBe(true)

    onCypher([[LOAD_RE, stateRow()], [EXCL_RE, [{ id: 'cert-x', name: 'CERT-X', labels: ['Certificate'], status: 'active', health: null }]], [UNEXCL_RE, { version: 3, status: 'active', removed: 1 }]])
    await removeServiceMapExclusion({ ...base, ciId: 'cert-x' })
    expect(isNow(callMatching(UNEXCL_RE)!.params['now'], before)).toBe(true)
  })

  it('applying a proposal and previewing also work without an instant', async () => {
    const expanded = [{ ciId: 'db-01', name: 'DB-01', level: 2, via: 'api-03', labels: ['Database'], status: 'active', health: null },
      { ciId: 'old-99', name: 'OLD-99', level: 2, via: 'api-03', labels: ['Server'], status: 'active', health: null },
      { ciId: 'srv-9', name: 'SRV-9', level: 2, via: 'api-03', labels: ['Server'], status: 'active', health: null }]
    onCypher([[LOAD_RE, stateRow()], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, expanded], [EXCL_RE, []],
      [APPLY_RE, { version: 3, status: 'active', added: 1, excluded: 0, removed: 0, included: 4 }]])
    const before = Date.now()
    await applyServiceMapProposal({ ...base, add: ['srv-9'], exclude: [], remove: [] })
    expect(isNow(callMatching(APPLY_RE)!.params['now'], before)).toBe(true)

    onCypher([[LOAD_RE, stateRow()]])
    await expect(previewServiceImpact({ tenantId: 't1', mapId: 'map-1' })).resolves.toMatchObject({ nodeCount: 3 })
  })
})
