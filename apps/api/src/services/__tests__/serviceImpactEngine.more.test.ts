/**
 * services/serviceImpact/engine.ts — the edges of the evaluation engine the
 * main suite (serviceImpactEngine.test.ts) does not walk.
 *
 * Why these matter to a user:
 *  - a map suspended by an alert storm must obey the same version guard as a
 *    normal write: if the map changed meanwhile, reload once; if it changes
 *    again, FAIL (retryable) instead of writing a note on a composition that
 *    is no longer the one evaluated;
 *  - partial node rows (no labels, no added_by, no status) must be read with
 *    their documented defaults, not crash the evaluation of the service;
 *  - a service with no criticality must reach the incident reconciliation as
 *    `null` (which then fails loudly there), never as `undefined`;
 *  - a malformed `autoSync` is refused before anything is written;
 *  - the periodic safety-net pass must report success, and say when it hit
 *    its page cap (the rest waits for the next pass).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ROLE_BY_CI_LABEL } from '../../lib/serviceVocabularies.js'
import { ALL_CI_LABELS as ALL_CI_LABELS_SEED } from '../../lib/ciLabels.js'

const TENANT_ROLES: ReadonlyMap<string, 'component' | 'infrastructure' | 'certificate'> =
  new Map(Object.entries(ROLE_BY_CI_LABEL) as [string, 'component' | 'infrastructure' | 'certificate'][])

vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../events/policy.js', () => ({ getEventPolicy: vi.fn().mockResolvedValue({ suppress_upstream_hops: 1,
  retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'], ignore_lifecycle_statuses: ['decommissioned'] }) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../serviceImpact/incident.js', () => ({
  reconcileServiceIncident: vi.fn().mockResolvedValue({ outcome: 'none', incidentId: null, incidentNumber: null }),
  recordServiceIncidentProblem: vi.fn().mockResolvedValue(undefined),
  clearServiceIncidentProblem: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../middleware/metrics.js', () => ({
  workflowPurposeMissingTotal: { inc: vi.fn() },
  serviceEvaluationsTotal: { inc: vi.fn() }, serviceEvaluationDurationSeconds: { observe: vi.fn() }, servicesHealth: { set: vi.fn() },
  serviceMapsStale: { set: vi.fn() },
  eventsSuppressedTotal: { inc: vi.fn() },
  redisLockTimeoutsTotal: { inc: vi.fn() }, redisLockHoldSeconds: { observe: vi.fn() },
}))
const TENANT_CI_LABELS = [...ALL_CI_LABELS_SEED].sort()
const TENANT_REL_TYPES = ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE']
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:       vi.fn(async () => TENANT_CI_LABELS),
  apocLabelFilterForTenant: vi.fn(async () => TENANT_CI_LABELS.map((l: string) => `+${l}`).join('|')),
}))
vi.mock('../../lib/ciMetamodelForTenant.js', () => ({
  serviceRelationshipTypesForTenant: vi.fn(async () => TENANT_REL_TYPES),
  suppressionRelPatternForTenant:    vi.fn(async () => TENANT_REL_TYPES.join('|')),
  serviceRolesForTenant:             vi.fn(async () => TENANT_ROLES),
}))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getStepNamesByPurpose: vi.fn(async (_s: unknown, _t: unknown, _e: unknown, purposes: readonly string[]) =>
    purposes.includes('implementation') ? ['deployment'] : ['scheduled']),
}))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { logger } = await import('../../lib/logger.js')
const metrics = await import('../../middleware/metrics.js')
const { reconcileServiceIncident } = await import('../serviceImpact/incident.js')
const {
  evaluateServiceMap, createServiceMap, evaluateStaleOrOldMaps, loadServiceMapState, upstreamWindowsOf, SERVICE_EVALUATION_HELD,
} = await import('../serviceImpact/engine.js')
const { DEFAULT_SERVICE_IMPACT_RULES_JSON } = await import('../../lib/serviceVocabularies.js')
const { MAX_PAGES, PAGE_SIZE } = await import('../../lib/pagedPass.js')

const NOW = '2026-09-22T10:00:00.000Z'
const log = logger.child({})
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

const LOAD_RE = /MATCH \(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->/
const WRITE_RE = /SET m\.health = \$health, m\.impact_score = toInteger\(\$impactScore\)/
const HOLD_RE = /SET m\.evaluated_at = \$now, m\.health_note = \$healthNote/
const PAGE_RE = /MATCH \(m:ServiceMap \{tenant_id: \$tenantId, status: 'active'\}\)/

const node = (o: Record<string, unknown>) => ({ name: o['ciId'], labels: ['Server'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'operational', healthSource: 'monitoring', status: 'active', changes: [], ...o })
function stateRow(over: { props?: Record<string, unknown>; nodes?: Record<string, unknown>[] } = {}) {
  return {
    props: { id: 'map-1', tenant_id: 't1', service_id: 'ba-1', name: 'Billing', status: 'active', version: 4, rules: DEFAULT_SERVICE_IMPACT_RULES_JSON, health: null, stale: false, node_ids: ['api-03', 'db-01'], ...over.props },
    nodes: over.nodes ?? [
      node({ ciId: 'api-03', labels: ['Application'], level: 1, role: 'entry', weight: 8, critical: true, via: null }),
      node({ ciId: 'db-01', labels: ['Database'], health: 'down' }),
    ],
  }
}
const writeRow = (over: Record<string, unknown> = {}) => ({ id: 'map-1', previous: null, changed: true, wasStale: false, serviceId: 'ba-1', name: 'Billing', criticality: 'mission_critical', incidentProblem: null, ...over })
const stormNodes = [node({ ciId: 'api-03', labels: ['Application'], level: 1, role: 'entry', weight: 8, critical: true, via: null, health: 'down', stormSources: ['Zabbix prod'] })]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

describe('storm hold and the version guard', () => {
  it('the map changed while suspending: reload once, then the hold is written on the new version', async () => {
    let load = 0
    onCypher([
      [LOAD_RE, () => stateRow({ props: { health: 'degraded', version: load++ === 0 ? 4 : 5 }, nodes: stormNodes })],
      [HOLD_RE, (p?: Record<string, unknown>) => (p?.['version'] === 5 ? { id: 'map-1', health: 'degraded', impactScore: 40 } : null)],
    ])
    const r = await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })
    expect(r).toMatchObject({ held: true, health: 'degraded', previousHealth: 'degraded', impactScore: 40, changed: false })
    expect(calls().filter((c) => HOLD_RE.test(c.cypher)).map((c) => c.params['version'])).toEqual([4, 5])
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }), expect.stringContaining('reloading and recomputing once'))
    expect(metrics.serviceEvaluationsTotal.inc).toHaveBeenCalledWith({ result: SERVICE_EVALUATION_HELD })
  })

  it('the map changed twice while suspending: error, nothing written, no event, metric error', async () => {
    onCypher([[LOAD_RE, stateRow({ props: { health: 'degraded' }, nodes: stormNodes })], [HOLD_RE, null]])
    await expect(evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW }))
      .rejects.toThrow(/ServiceMap map-1 changed while suspending its evaluation \(expected version 4, 2 attempts\): nothing was written \(tenant t1\)/)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(reconcileServiceIncident).not.toHaveBeenCalled()
    expect(metrics.serviceEvaluationsTotal.inc).toHaveBeenCalledWith({ result: 'error' })
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})

describe('reading the map', () => {
  it('node rows with no labels, no added_by and no status get their documented defaults', async () => {
    onCypher([[LOAD_RE, stateRow({ nodes: [node({ ciId: 'db-01', labels: null, addedBy: null, status: null, name: null })] })]])
    const state = await loadServiceMapState(session as never, 't1', 'map-1', NOW)
    expect(state.nodes[0]).toMatchObject({ ciId: 'db-01', name: '', labels: [], addedBy: 'auto', status: null })
  })

  it('an upstream window on a node without a name is labelled by the CI id', () => {
    const n = { ciId: 'vm-1', name: '', stormSources: [], changeWindow: { changeId: 'c1', code: 'CHG-1', step: 'deployment', viaCiId: 'srv-1', viaCiName: 'SRV-01', upstream: true } }
    expect(upstreamWindowsOf([n as never])).toEqual([{ name: 'vm-1', changeCode: 'CHG-1', viaName: 'SRV-01' }])
  })
})

describe('evaluateServiceMap — defaults', () => {
  it('without an explicit instant the evaluation is stamped with the current time', async () => {
    onCypher([[LOAD_RE, stateRow()], [WRITE_RE, writeRow()]])
    const before = Date.now()
    await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health' })
    const written = calls().find((c) => WRITE_RE.test(c.cypher))!.params['now'] as string
    expect(Date.parse(written)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(written)).toBeLessThanOrEqual(Date.now())
  })

  it('a service without criticality reaches the reconciliation as null, never undefined', async () => {
    onCypher([[LOAD_RE, stateRow()], [WRITE_RE, writeRow({ criticality: undefined })]])
    await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })
    expect(vi.mocked(reconcileServiceIncident).mock.calls[0]![0].criticality).toBeNull()
  })
})

describe('createServiceMap — input validation', () => {
  it('a non-boolean autoSync is refused before any session is opened', async () => {
    await expect(createServiceMap({ tenantId: 't1', serviceId: 'ba-1', maxDepth: 2, relationshipTypes: ['DEPENDS_ON'], actorId: 'u-1', autoSync: 'yes' as never }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' }, message: 'autoSync must be a boolean. Got: "yes"' })
    expect(getSession).not.toHaveBeenCalled()
  })
})

describe('evaluateStaleOrOldMaps — outcome of the safety-net pass', () => {
  it('all maps evaluated: the pass returns its counts', async () => {
    let page = 0
    onCypher([
      [PAGE_RE, () => (page++ === 0 ? [{ tenantId: 't1', id: 'm1' }] : [])],
      [LOAD_RE, stateRow()],
      [WRITE_RE, writeRow({ changed: false, previous: 'degraded' })],
    ])
    await expect(evaluateStaleOrOldMaps('t1', NOW)).resolves.toEqual({ evaluated: 1, failed: 0, truncated: false })
  })

  it('page cap reached: logged as truncated (the rest waits for the next pass)', async () => {
    let page = 0
    // Every page is full, with ids that keep increasing: the cursor advances
    // until the cap. The maps vanish on load, so each one fails fast.
    onCypher([
      [PAGE_RE, () => {
        const p = page++
        return Array.from({ length: PAGE_SIZE }, (_, i) => ({ tenantId: 't1', id: `m${String(p).padStart(3, '0')}-${String(i).padStart(4, '0')}` }))
      }],
      [LOAD_RE, null],
    ])
    await expect(evaluateStaleOrOldMaps('t1', NOW)).rejects.toThrow(new RegExp(`${MAX_PAGES * PAGE_SIZE}/${MAX_PAGES * PAGE_SIZE} service maps failed`))
    expect(page).toBe(MAX_PAGES)
    expect(log.warn).toHaveBeenCalledWith({ evaluated: MAX_PAGES * PAGE_SIZE }, expect.stringContaining('page cap reached'))
  }, 30_000)
})
