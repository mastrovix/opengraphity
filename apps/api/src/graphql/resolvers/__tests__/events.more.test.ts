/**
 * events.ts — the reads the main events.test.ts leaves out: the "resolved
 * since" filter, the counters of correlated / suppressed events on Incident
 * and Change, and the invariants that must fail loudly.
 *
 * Why these behaviours matter:
 *  - "resolved since" compares ISO strings in Cypher: an unparseable or
 *    non-ISO date would give an arbitrary page with no error, so it must be
 *    normalised or refused;
 *  - the counters on an incident / change page must stay inside the tenant
 *    and must say NOT_FOUND for a ticket that is not there, instead of 0
 *    (which reads as "nothing was correlated");
 *  - an alias whose CI vanished, a CI that is not there when creating an
 *    alias, and a counters query with no row are data faults to report, not
 *    to paper over.
 *
 * The module mocks mirror events.test.ts so the resolver loads the same way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
// The tenant impact relations are faked; the resolver must not hard-code DEPENDS_ON.
vi.mock('../../../lib/ciMetamodelForTenant.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  impactRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|RUNS_ON'),
}))
// severity_map impact/urgency are checked against the tenant dictionary (faked here).
vi.mock('../../../lib/domainMatrix.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/domainMatrix.js')>()
  const allowed: Record<string, string[]> = { impact: ['low', 'medium', 'high'], urgency: ['low', 'medium', 'high'] }
  return {
    ...orig,
    assertDomainValue: vi.fn(async (_t: string, vocabulary: string, value: unknown) => {
      const values = allowed[vocabulary] ?? []
      if (typeof value !== 'string' || !values.includes(value)) {
        const { ValidationError } = await import('../../../lib/errors.js')
        throw new ValidationError(`${vocabulary}: "${String(value)}" is not in the dictionary of this tenant. Allowed: ${values.join(', ')}.`)
      }
      return value
    }),
  }
})
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/incidentService.js', () => ({ createIncident: vi.fn() }))
vi.mock('../../../jobs/eventIngestWorker.js', () => ({ enqueueEvents: vi.fn() }))
vi.mock('../../../services/eventService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/eventService.js')>()),
  getEventPolicy: vi.fn(), setEventPolicy: vi.fn().mockResolvedValue(undefined), recomputeCIHealth: vi.fn().mockResolvedValue('down'),
}))
// The shared incident opening and the pipeline have their own tests (eventCorrelation.test.ts).
vi.mock('../../../services/eventCorrelation.js', () => ({
  openIncidentFromEvent: vi.fn(), runEventPipeline: vi.fn(),
  // Group key/identity (pure, same rules as the service) and the lock options.
  GROUP_LOCK_OPTS: { ttlSeconds: 30, waitMs: 5_000, pollMs: 100 },
  groupLockKey: (t: string, g: string, id: string) => `og:events:group:${t}:${g === 'ci' ? 'ci' : 'fp'}:${id}`,
  groupIdOf: (policy: { group_by: string }, ev: { ciId: string | null; props: Record<string, unknown> }) => (policy.group_by === 'ci' && ev.ciId ? ev.ciId : String(ev.props['fingerprint'] ?? ev.props['id'])),
}))
// The Redis lock runs the critical section at once.
vi.mock('../../../lib/redisLock.js', () => ({ withRedisLock: vi.fn(async (_k: string, _o: unknown, run: () => Promise<unknown>) => run()) }))
// Storm counters (Redis) are tested in eventStorm.test.ts.
vi.mock('../../../services/eventStorm.js', () => ({ listStormSources: vi.fn().mockResolvedValue([]) }))
vi.mock('../change/queries.js', () => ({ change: vi.fn() }))
// The type filter asks the tenant metamodel for the label: a tenant with the shipped types plus its own erp_system.
vi.mock('../../../lib/ciTypeNameToLabel.js', () => ({
  ciLabelForTypeName: vi.fn(async (_t: string, name: string) =>
    ({ database_instance: 'DatabaseInstance', erp_system: 'ErpSystem' } as Record<string, string>)[name] ?? null),
  ciTypeNamesForTenant: vi.fn(async () => ['database_instance', 'erp_system']),
}))
// reevaluateEvent: the terminal incident steps come from the workflow.
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn().mockResolvedValue([
    { name: 'new', isInitial: true, isTerminal: false, isOpen: true, category: 'new', stepOrder: 1 },
    { name: 'resolved', isInitial: false, isTerminal: true, isOpen: false, category: 'resolved', stepOrder: 4 },
    { name: 'closed', isInitial: false, isTerminal: true, isOpen: false, category: 'closed', stepOrder: 5 },
  ]),
}))


const { eventResolvers } = await import('../events.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')

const admin: GraphQLContext = { tenantId: 'tenant-1', userId: 'adm-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const operator: GraphQLContext = { ...admin, userId: 'op-1', role: 'operator', permissions: perms('operator') }
const session = { close: vi.fn().mockResolvedValue(undefined) }

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

describe('events — "resolved since" filter', () => {
  it('a parseable date is normalised to ISO UTC before the lexicographic comparison', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ total: 0, items: [] } as never)
    await eventResolvers.Query.events(null, { filter: { resolvedSince: 'Sep 9, 2026 10:00 UTC' } }, operator)
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]! as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('e.resolved_at >= $resolvedSince')
    expect(params['resolvedSince']).toBe('2026-09-09T10:00:00.000Z')
    expect(params['tenantId']).toBe('tenant-1')
  })

  it('an unparseable date is refused before any query', async () => {
    await expectCode(eventResolvers.Query.events(null, { filter: { resolvedSince: 'yesterday' } }, operator), 'BAD_USER_INPUT', /resolvedSince must be an ISO date/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})

describe('eventStats', () => {
  it('a counters query with no row is a loud error, not zeros', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(eventResolvers.Query.eventStats(null, null, operator)).rejects.toThrow(/counters query returned no row/)
    expect(session.close).toHaveBeenCalled()
  })
})

describe('CI aliases — data faults', () => {
  it('an alias whose CI is gone is reported, naming the alias', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'al-9', kind: 'hostname', value: 'x' }, ciId: null }] as never)
    await expect(eventResolvers.Query.ciAliases(null, { ciId: 'ci-1' }, operator)).rejects.toThrow('CIAlias al-9 has no ALIAS_OF target')
  })

  it('creating an alias on a CI that is not in this tenant is NOT_FOUND', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never)
    await expectCode(eventResolvers.Mutation.createCIAlias(null, { ciId: 'ci-x', kind: 'hostname', value: 'db-01' }, admin), 'NOT_FOUND')
    const create = vi.mocked(runQueryOne).mock.calls[1]! as [unknown, string, Record<string, unknown>]
    expect(create[1]).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(session.close).toHaveBeenCalled()
  })
})

describe('counters on the Incident and Change pages', () => {
  const cases = [
    ['Incident', 'correlatedEventCount', /CORRELATED_INTO/],
    ['Incident', 'correlatedEventsPurged', /correlated_events_purged/],
    ['Change', 'suppressedEventCount', /SUPPRESSED_BY/],
    ['Change', 'suppressedEventsPurged', /suppressed_events_purged/],
  ] as const

  for (const [type, fieldName, re] of cases) {
    it(`${type}.${fieldName}: the number, scoped to the tenant; a missing ${type} is NOT_FOUND`, async () => {
      const resolver = (eventResolvers[type] as unknown as Record<string, (p: { id: string }, a: unknown, c: GraphQLContext) => Promise<number>>)[fieldName]!
      vi.mocked(runQueryOne).mockResolvedValueOnce({ n: 7 } as never)
      await expect(resolver({ id: 'x-1' }, {}, operator)).resolves.toBe(7)
      const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]! as [unknown, string, Record<string, unknown>]
      expect(cypher).toMatch(re)
      expect(params).toEqual({ id: 'x-1', tenantId: 'tenant-1' })

      vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
      await expectCode(resolver({ id: 'x-2' }, {}, operator), 'NOT_FOUND')
      expect(session.close).toHaveBeenCalledTimes(2)
    })
  }
})
