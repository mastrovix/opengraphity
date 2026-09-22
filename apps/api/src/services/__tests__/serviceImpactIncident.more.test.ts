/**
 * services/serviceImpact/incident.ts — the edges of the service incident the
 * main suite (serviceImpactIncident.test.ts) does not walk.
 *
 * Why these matter to a user:
 *  - the "critical services" banner on the Services page is driven by
 *    `criticalServiceCriticalities`: it must follow the customer's matrix and
 *    fail loudly on an empty impact dictionary, never show an empty banner;
 *  - a map or incident that vanishes while being linked must stop the job
 *    (retryable) instead of publishing "incident opened" for a link that
 *    does not exist;
 *  - partial rows from the graph (no number, no cause list) must not crash
 *    the reconciliation or invent data;
 *  - a Redis hiccup while clearing the idempotency marker must not turn a
 *    successful auto-resolve into a failed job (which would retry and write
 *    a second "resolved" comment);
 *  - a corrupt problem stored on the map is reported as corrupt, not guessed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisStore = vi.hoisted(() => new Map<string, string>())
const fakeRedis = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === 'NX' && redisStore.has(key)) return null
    redisStore.set(key, value)
    return 'OK'
  }),
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  del: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
  eval: vi.fn(async (_lua: string, _n: number, key: string, owner: string) => {
    if (redisStore.get(key) === owner) { redisStore.delete(key); return 1 }
    return 0
  }),
}))
const incidentService = vi.hoisted(() => ({
  createIncident:     vi.fn(),
  addIncidentComment: vi.fn().mockResolvedValue(undefined),
  resolveIncident:    vi.fn().mockResolvedValue(undefined),
  setIncidentTitle:   vi.fn().mockResolvedValue(undefined),
}))
const workflow = vi.hoisted(() => ({ getAvailableTransitions: vi.fn().mockResolvedValue([]) }))

vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../middleware/metrics.js', () => ({
  serviceIncidentsOpenedTotal: { inc: vi.fn() }, serviceIncidentsResolvedTotal: { inc: vi.fn() },
  redisLockTimeoutsTotal: { inc: vi.fn() }, redisLockHoldSeconds: { observe: vi.fn() },
}))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../lib/bullmq.js', () => ({ getSharedRedis: () => fakeRedis, getQueue: vi.fn() }))
vi.mock('../events/deps.js', () => ({
  engine:    async () => workflow,
  incidents: async () => incidentService,
  queue:     async () => ({}),
}))
vi.mock('../events/incidentWorkflow.js', () => ({
  incidentStepInfo:        vi.fn(async () => ({ resolvedStep: 'resolved', terminalSteps: ['resolved', 'closed'] })),
  incidentStep:            vi.fn(),
  reopenIncident:          vi.fn().mockResolvedValue('in_progress'),
  runMonitoringTransition: vi.fn().mockResolvedValue(undefined),
  loadDefinitionTransitions: vi.fn().mockResolvedValue([]),
  findLinkedOpenIncident:  vi.fn(),
}))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { logger } = await import('../../lib/logger.js')
const metrics = await import('../../middleware/metrics.js')
const { runMonitoringTransition, loadDefinitionTransitions } = await import('../events/incidentWorkflow.js')
const {
  reconcileServiceIncident, serviceImpactOf, criticalServiceCriticalities, findTechnicalIncidents,
  serviceIncidentProblemOf, parseServiceIncidentProblem,
} = await import('../serviceImpact/incident.js')
const { DEFAULT_SERVICE_IMPACT_RULES } = await import('../../lib/serviceVocabularies.js')
const { FAKE_VOCABULARIES } = await import('../../lib/__tests__/domainMatrixFake.js')
const { GraphQLError } = await import('graphql')

import type { StoredCause } from '../serviceImpact/history.js'
import type { ServiceImpactRules } from '../../lib/serviceVocabularies.js'

const NOW = '2026-09-22T10:00:00.000Z'
const log = logger.child({})
const session = { close: vi.fn().mockResolvedValue(undefined) }
const INFO = { resolvedStep: 'resolved', terminalSteps: ['resolved', 'closed'] }

const FIND_RE  = /MATCH \(i:Incident \{tenant_id: \$tenantId\}\)-\[r:IMPACTS_SERVICE\]->/
const LINK_RE  = /MERGE \(i\)-\[r:IMPACTS_SERVICE\]->\(m\)/
const TECH_RE  = /MATCH \(i:Incident \{tenant_id: \$tenantId\}\)-\[:AFFECTED_BY\]->/
const BY_ID_RE = /RETURN i\.number AS number/

function cause(ciId: string): StoredCause {
  return {
    ciId, health: 'down', weight: 5, critical: false,
    ci:   { id: ciId, name: ciId.toUpperCase(), type: 'database', health: 'down' },
    path: [],
  }
}

function onCypher(rules: Array<[RegExp, unknown]>) {
  const all: Array<[RegExp, unknown]> = [...rules, [TECH_RE, []]]
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of all) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => {
    const r = await impl(s, c, p)
    return r == null ? [] : Array.isArray(r) ? r : [r]
  }) as never)
}

function input(over: Partial<Parameters<typeof reconcileServiceIncident>[0]> = {}) {
  return {
    tenantId: 't1', mapId: 'map-1', serviceId: 'ba-1', serviceName: 'Billing',
    criticality: 'business_critical', status: 'active' as const,
    rules: { ...DEFAULT_SERVICE_IMPACT_RULES } as ServiceImpactRules,
    health: 'down' as const, impactScore: 62, causes: [cause('db-01')],
    actorId: 'monitoring', now: NOW,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  redisStore.clear()
  vi.mocked(getSession).mockReturnValue(session as never)
  incidentService.createIncident.mockResolvedValue({ id: 'inc-9', number: 'INC00000099' })
  workflow.getAvailableTransitions.mockResolvedValue([])
  vi.mocked(loadDefinitionTransitions).mockResolvedValue([])
})

describe('criticalServiceCriticalities — the "critical services" banner', () => {
  it('returns the criticalities the matrix maps to the HIGHEST impact (last of the dictionary)', async () => {
    // Factory matrix: mission/business critical → high, the others → medium.
    expect((await criticalServiceCriticalities('t1')).sort()).toEqual(['business_critical', 'mission_critical'])
  })

  it('an empty impact dictionary is an error, not an empty banner', async () => {
    const vocab = FAKE_VOCABULARIES as Record<string, readonly string[]>
    const original = vocab['impact']!
    vocab['impact'] = []
    try {
      await expect(criticalServiceCriticalities('t1')).rejects.toThrow(/Dictionary "impact" of tenant t1 is empty/)
    } finally {
      vocab['impact'] = original
    }
  })
})

describe('serviceImpactOf — missing criticality without a service name', () => {
  it('names the map only, and the i18n params carry an empty service', async () => {
    const err = await serviceImpactOf('t1', '', { mapId: 'map-7' }).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toMatch(/^The service \(map map-7\) has no criticality/)
    expect((err!.extensions['i18n'] as { params: Record<string, string> }).params).toMatchObject({ service: '', map: 'map-7' })
  })
})

describe('findTechnicalIncidents', () => {
  it('no cause CI → no query at all (and no empty list in the description)', async () => {
    await expect(findTechnicalIncidents(session as never, 't1', [], INFO)).resolves.toEqual([])
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('missing number or title from the graph become empty strings, not "null"', async () => {
    onCypher([[TECH_RE, [{ number: null, title: null }, { number: 'INC1', title: 'Disk full' }]]])
    await expect(findTechnicalIncidents(session as never, 't1', ['db-01'], INFO))
      .resolves.toEqual([{ number: '', title: '' }, { number: 'INC1', title: 'Disk full' }])
  })
})

describe('linking the incident to the map', () => {
  it('map or incident vanished while linking → the job fails and NO "incident opened" event is published', async () => {
    onCypher([[FIND_RE, null], [LINK_RE, null]])
    await expect(reconcileServiceIncident(input())).rejects.toThrow(/Incident inc-9 or ServiceMap map-1 vanished while linking them \(tenant t1\)/)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(metrics.serviceIncidentsOpenedTotal.inc).not.toHaveBeenCalled()
    // The marker survives: the retry relinks the same incident instead of opening a second one.
    expect(redisStore.get('og:services:incident:opened:t1:map-1')).toBe('inc-9')
  })
})

describe('partial rows from the graph', () => {
  it('an open incident with no number and no stored cause list: causes count as changed, one comment, empty number', async () => {
    onCypher([
      [FIND_RE, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', number: null, causeIds: 'not-a-list', maintenanceNotedAt: null, keptOpenNotedAt: null }],
      [LINK_RE, { at: NOW }],
    ])
    const r = await reconcileServiceIncident(input())
    expect(r).toEqual({ outcome: 'updated', incidentId: 'inc-1', incidentNumber: '' })
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
  })

  it('relinking an orphan incident whose number is missing reports an empty number, not "null"', async () => {
    redisStore.set('og:services:incident:opened:t1:map-1', 'inc-orphan')
    onCypher([[FIND_RE, null], [BY_ID_RE, { number: null, step: 'new' }], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input())
    expect(r).toEqual({ outcome: 'opened', incidentId: 'inc-orphan', incidentNumber: '' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })

  it('an orphan whose workflow step is unknown (no instance) is still relinked, never duplicated', async () => {
    redisStore.set('og:services:incident:opened:t1:map-1', 'inc-orphan')
    onCypher([[FIND_RE, null], [BY_ID_RE, { number: 'INC5', step: null }], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input())
    expect(r).toMatchObject({ outcome: 'opened', incidentId: 'inc-orphan', incidentNumber: 'INC5' })
  })
})

describe('auto-resolve edges', () => {
  it('failing to clear the idempotency marker does not fail a successful resolve', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([{ toStep: 'resolved' }])
    onCypher([[FIND_RE, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'in_progress', number: 'INC42', causeIds: [], maintenanceNotedAt: null, keptOpenNotedAt: null }], [LINK_RE, { at: NOW }]])
    fakeRedis.del.mockRejectedValueOnce(new Error('redis down'))
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r.outcome).toBe('resolved')
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ mapId: 'map-1' }), expect.stringContaining('could not be cleared'))
    expect(metrics.serviceIncidentsResolvedTotal.inc).toHaveBeenCalledTimes(1)
  })

  it('an intermediate step without a label is named by its id in the hop note and the summary', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([{ toStep: 'assigned' }])
    vi.mocked(loadDefinitionTransitions).mockResolvedValue([
      { fromStep: 'new', toStep: 'assigned', toLabel: null, trigger: 'manual', condition: null },
      { fromStep: 'assigned', toStep: 'resolved', toLabel: 'Resolved', trigger: 'manual', condition: null },
    ] as never)
    onCypher([[FIND_RE, { incidentId: 'inc-1', instanceId: 'wi-1', step: 'new', number: 'INC42', causeIds: [], maintenanceNotedAt: null, keptOpenNotedAt: null }], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r.outcome).toBe('resolved')
    expect(vi.mocked(runMonitoringTransition).mock.calls[0]![6]).toContain('assigned')
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('assigned')
  })
})

describe('the problem recorded on the map', () => {
  it('a non-Error thrown value still becomes a message', () => {
    expect(serviceIncidentProblemOf('plain string')).toEqual({ key: null, params: {}, message: 'plain string' })
  })

  it('i18n params are stringified and null values become empty strings', () => {
    const err = new GraphQLError('x', { extensions: { i18n: { key: 'errors.k', params: { n: 3, missing: null } } } })
    expect(serviceIncidentProblemOf(err)).toEqual({ key: 'errors.k', params: { n: '3', missing: '' }, message: 'x' })
  })

  it('an empty i18n key is treated as no key (the message is the fallback)', () => {
    const err = new GraphQLError('x', { extensions: { i18n: { key: '', params: { a: 'b' } } } })
    expect(serviceIncidentProblemOf(err)).toEqual({ key: null, params: {}, message: 'x' })
  })

  it('a stored value that is not a string is reported as such', () => {
    expect(() => parseServiceIncidentProblem({ message: 'x' }, 'map-1')).toThrow(/incident_problem is not a JSON string \(got object\)/)
  })

  it('a stored problem with a string key round-trips', () => {
    expect(parseServiceIncidentProblem('{"key":"errors.k","params":{"a":"b"},"message":"m"}', 'map-1'))
      .toEqual({ key: 'errors.k', params: { a: 'b' }, message: 'm' })
  })

  it('params that are null are an unexpected shape, not an empty object', () => {
    expect(() => parseServiceIncidentProblem('{"key":null,"params":null,"message":"m"}', 'map-1')).toThrow(/unexpected shape/)
  })
})
