/**
 * Discovery reconciliation: what the CMDB looks like after a run.
 *
 * reconciliationEngine.test.ts counts outcomes with a session that never runs
 * the Cypher. This file runs the transaction callbacks against a fake `tx`
 * that answers by query shape, so the parameters actually sent are visible.
 * Why these behaviours matter to a CMDB owner:
 *  - one badly shaped CI (an object where a string is expected) must become a
 *    conflict naming that CI, and the rest of the run must still be written;
 *  - a database error while looking a CI up must abort, never read as "not
 *    found": that would CREATE a duplicate of an existing CI;
 *  - an update writes only real changes, never overwrites system fields or
 *    fields an operator locked, and records old/new values in the sync history;
 *  - a CI seen again is no longer "stale", even when nothing else changed;
 *  - relationships: created only once, counted only when new, removed when
 *    the source stops reporting them, and never built with an unsafe type;
 *  - every query is scoped by tenant and source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DiscoveredCI, SyncSourceConfig } from '@opengraphity/discovery'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('@opengraphity/discovery', () => ({
  applyMappingRules: vi.fn((ci: unknown) => ci),
  inferCIType: vi.fn(() => 'server'),
  normalizeProperties: vi.fn((props: unknown) => props),
}))
vi.mock('../ciTypeResolution.js', () => ({
  CITypeResolver: {
    forSource: vi.fn(async () => ({
      resolve: (t: string) => (t === 'server'
        ? { ok: true, type: { name: 'server', label: 'Server' }, via: 'name' }
        : { ok: false, reason: `unknown type ${t}` }),
    })),
  },
}))
vi.mock('../../services/serviceImpact/sync.js', () => ({ notifyCIGraphChanged: vi.fn().mockResolvedValue(0) }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { reconcileBatch, assertDiscoveredPropertyKeys, CONFLICT_INVALID_PROPERTIES } = await import('../reconciliationEngine.js')
const { getSession } = await import('@opengraphity/neo4j')
const { notifyCIGraphChanged } = await import('../../services/serviceImpact/sync.js')
const { logger } = await import('../../lib/logger.js')

type Row = Record<string, unknown>
type Handler = (cypher: string, params: Row) => Row[] | Promise<Row[]>

/** A session whose tx.run answers with the rows the handler returns for that query. */
function sessionFor(handler: Handler) {
  const calls: Array<{ cypher: string; params: Row }> = []
  const tx = {
    run: vi.fn(async (cypher: string, params: Row) => {
      calls.push({ cypher, params })
      const rows = await handler(cypher, params)
      return { records: rows.map((r) => ({ get: (k: string) => r[k] })) }
    }),
  }
  const s = {
    calls,
    executeRead:  vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    executeWrite: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

const source = { id: 'src-1', mapping_rules: [] } as unknown as SyncSourceConfig
const stats = () => ({ ciCreated: 0, ciUpdated: 0, ciUnchanged: 0, ciStale: 0, ciConflicts: 0, relationsCreated: 0, relationsRemoved: 0 })
const ci = (over: Partial<DiscoveredCI> = {}): DiscoveredCI => ({
  external_id: 'ext-1', source: 'csv', ci_type: 'server', name: 'web-01',
  properties: {}, tags: {}, relationships: [], ...over,
})

const isFind = (c: string) => c.includes('RETURN ci.id AS id, properties(ci) AS props')
const isIdLookup = (c: string) => c.includes('RETURN ci.id AS id') && !c.includes('properties(ci)')

beforeEach(() => vi.clearAllMocks())

describe('property shape (D-20)', () => {
  it('assertDiscoveredPropertyKeys accepts primitives, lists of primitives and nulls', () => {
    expect(() => assertDiscoveredPropertyKeys({ a: 'x', b: 1, c: true, d: ['x', 2], e: null, f: undefined }, 'ext')).not.toThrow()
  })

  it('names the CI and the offending properties when a value is an object', () => {
    expect(() => assertDiscoveredPropertyKeys({ tags: { env: 'prod' }, ports: [{ n: 80 }], ok: 'x' }, 'ext-9'))
      .toThrow(/CI ext-9: these properties are not primitive values.*: tags, ports\./s)
  })

  it('a CI with a non-primitive property becomes a conflict, and the next CI in the batch is still created', async () => {
    const s = sessionFor((c) => (c.startsWith('MERGE (ci:ConfigurationItem') ? [{ created: true }] : []))
    const st = stats()
    await reconcileBatch([
      ci({ external_id: 'bad', properties: { meta: { nested: true } } }),
      ci({ external_id: 'good', properties: { os: 'linux' } }),
    ], source, 'run-1', 'tenant-1', st)

    expect(st).toMatchObject({ ciConflicts: 1, ciCreated: 1 })
    const conflict = s.calls.find((x) => x.cypher.includes(`conflict_kind: '${CONFLICT_INVALID_PROPERTIES}'`))!
    expect(conflict.params).toMatchObject({
      tenantId: 'tenant-1', sourceId: 'src-1', runId: 'run-1', externalId: 'bad', ciType: 'server',
      conflictFields: '["properties"]',
    })
    // The message the admin reads names the property to fix.
    expect(conflict.params['message']).toMatch(/not primitive values.*meta/s)
  })

  it('a conflict on a CI without a type records an empty type rather than failing', async () => {
    const s = sessionFor(() => [])
    // No ci_type: inferred as "server", so the CI reaches createCI and fails there on its keys.
    await reconcileBatch([ci({ ci_type: undefined as unknown as string, properties: { 'bad key': 1 } })], source, 'run-1', 'tenant-1', stats())
    const conflict = s.calls.find((x) => x.cypher.includes(CONFLICT_INVALID_PROPERTIES))!
    expect(conflict.params['ciType']).toBe('')
  })
})

describe('lookup failures never look like "not found"', () => {
  it('a database error in the lookup aborts the batch (no duplicate CREATE) and closes the session', async () => {
    const s = sessionFor((c) => { if (isFind(c)) throw new Error('Neo.TransientError'); return [] })
    await expect(reconcileBatch([ci()], source, 'run-1', 'tenant-1', stats())).rejects.toThrow('Neo.TransientError')
    expect(s.calls.some((x) => x.cypher.startsWith('MERGE'))).toBe(false)
    expect(s.close).toHaveBeenCalledOnce()
    expect(vi.mocked(logger.error)).toHaveBeenCalled()
    // The graph notification is skipped: nothing was committed.
    expect(notifyCIGraphChanged).not.toHaveBeenCalled()
  })

  it('a non-Error rejection is wrapped so the run fails with a readable message', async () => {
    sessionFor((c) => { if (isFind(c)) return Promise.reject('socket closed'); return [] })
    await expect(reconcileBatch([ci()], source, 'run-1', 'tenant-1', stats())).rejects.toThrow('socket closed')
  })

  it('the lookup is keyed by external id, source AND tenant', async () => {
    const s = sessionFor((c) => (c.startsWith('MERGE') ? [{ created: true }] : []))
    await reconcileBatch([ci()], source, 'run-1', 'tenant-1', stats())
    expect(s.calls[0]!.params).toEqual({ externalId: 'ext-1', sourceId: 'src-1', tenantId: 'tenant-1' })
  })
})

describe('updating an existing CI', () => {
  const existingProps = (over: Row = {}) => ({
    id: 'ci-1', name: 'web-01', os: 'linux', ram: 8, owner: 'ops', discovery_status: 'active',
    discovery_source: 'csv', discovery_locked_fields: ['owner'], created_at: 'old', ...over,
  })

  it('writes only real changes, never system or locked fields, and records old/new values', async () => {
    const s = sessionFor((c) => (isFind(c) ? [{ id: 'ci-1', props: existingProps() }] : []))
    const st = stats()
    await reconcileBatch([ci({
      name: 'web-01-renamed',
      // ram changes; os is identical (as a string); owner is locked but equal; created_at is a system field.
      properties: { os: 'linux', ram: 16, owner: 'ops', created_at: 'forged' },
    })], source, 'run-1', 'tenant-1', st)

    expect(st).toMatchObject({ ciUpdated: 1, ciConflicts: 0 })
    const set = s.calls.find((x) => x.cypher.includes('SET ci += $updates'))!
    expect(set.params['id']).toBe('ci-1')
    expect(set.params['tenantId']).toBe('tenant-1')
    const updates = set.params['updates'] as Row
    expect(updates).toMatchObject({ ram: 16, name: 'web-01-renamed', discovery_status: 'active', discovery_stale_since: null })
    expect(updates).not.toHaveProperty('os')
    expect(updates).not.toHaveProperty('owner')
    expect(updates['created_at']).toBeUndefined()

    const history = s.calls.find((x) => x.cypher.includes('CREATE (r:SyncChangeRecord'))!
    expect(history.params).toMatchObject({ ciId: 'ci-1', sourceId: 'src-1', tenantId: 'tenant-1' })
    expect(JSON.parse(history.params['changedFields'] as string)).toEqual(['ram', 'name'])
    expect(JSON.parse(history.params['oldValues'] as string)).toEqual({ ram: 8, name: 'web-01' })
    expect(JSON.parse(history.params['newValues'] as string)).toEqual({ ram: 16, name: 'web-01-renamed' })
  })

  it('a stale CI seen again identical is back to active, with no history entry', async () => {
    const s = sessionFor((c) => (isFind(c) ? [{ id: 'ci-1', props: existingProps({ discovery_status: 'stale', discovery_locked_fields: undefined }) }] : []))
    const st = stats()
    await reconcileBatch([ci({ properties: { os: 'linux' } })], source, 'run-1', 'tenant-1', st)
    expect(st.ciUnchanged).toBe(1)
    const set = s.calls.find((x) => x.cypher.includes('SET ci += $updates'))!
    expect((set.params['updates'] as Row)['discovery_status']).toBe('active')
    expect(s.calls.some((x) => x.cypher.includes('SyncChangeRecord'))).toBe(false)
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.objectContaining({ ciId: 'ci-1' }), expect.stringContaining('no longer stale'))
  })

  it('a CI that never had a name gets one, and the change says it had none', async () => {
    const s = sessionFor((c) => (isFind(c) ? [{ id: 'ci-1', props: existingProps({ name: undefined }) }] : []))
    await reconcileBatch([ci({ properties: {} })], source, 'run-1', 'tenant-1', stats())
    const history = s.calls.find((x) => x.cypher.includes('SyncChangeRecord'))!
    expect(JSON.parse(history.params['oldValues'] as string)).toEqual({ name: null })
  })

  it('a changed LOCKED field is a conflict: the CI is not updated but is marked as seen', async () => {
    const s = sessionFor((c) => (isFind(c) ? [{ id: 'ci-1', props: existingProps() }] : []))
    const st = stats()
    await reconcileBatch([ci({ properties: { owner: 'someone-else' } })], source, 'run-1', 'tenant-1', st)
    expect(st.ciConflicts).toBe(1)
    expect(s.calls.some((x) => x.cypher.includes('SET ci += $updates'))).toBe(false)
    const seen = s.calls.find((x) => x.cypher.includes("ci.discovery_status = 'active'"))!
    expect(seen.params).toMatchObject({ id: 'ci-1', tenantId: 'tenant-1' })
    const conflict = s.calls.find((x) => x.cypher.includes('MERGE (c:SyncConflict'))!
    expect(conflict.params).toMatchObject({ conflictFields: '["owner"]', existingCiId: 'ci-1', ciType: 'server' })
  })
})

describe('relationships', () => {
  const rel = (target: string, relation_type: string, direction: 'outgoing' | 'incoming' = 'outgoing') =>
    ({ target_external_id: target, relation_type, direction }) as DiscoveredCI['relationships'][number]

  function relSession(opts: { targets?: Record<string, string>; isNew?: boolean; removed?: unknown; selfMissing?: boolean } = {}) {
    const targets = opts.targets ?? { 'db-1': 'ci-db', 'lb-1': 'ci-lb' }
    return sessionFor((c, p) => {
      if (isFind(c)) return []
      if (c.startsWith('MERGE (ci:ConfigurationItem')) return [{ created: true }]
      if (isIdLookup(c)) {
        if (p['externalId'] === 'ext-1') return opts.selfMissing ? [] : [{ id: 'ci-self' }]
        const t = targets[p['externalId'] as string]
        return t ? [{ id: t }] : []
      }
      if (c.includes('MERGE (a)-[r:')) return [{ isNew: opts.isNew ?? true }]
      if (c.includes('DELETE r')) return [{ n: opts.removed ?? 0 }]
      return []
    })
  }

  it('outgoing and incoming relations are merged in the right direction and counted when new', async () => {
    const s = relSession()
    const st = stats()
    await reconcileBatch([ci({ relationships: [rel('db-1', 'DEPENDS_ON'), rel('lb-1', 'MEMBER_OF', 'incoming')] })], source, 'run-1', 'tenant-1', st)
    const merges = s.calls.filter((x) => x.cypher.includes('MERGE (a)-[r:'))
    expect(merges[0]!.cypher).toContain('MATCH (a:ConfigurationItem {id: $fromId}), (b:ConfigurationItem {id: $toId})')
    expect(merges[0]!.cypher).toContain('MERGE (a)-[r:DEPENDS_ON]->(b)')
    // Incoming: the target is the start node.
    expect(merges[1]!.cypher).toContain('MATCH (a:ConfigurationItem {id: $toId}), (b:ConfigurationItem {id: $fromId})')
    expect(merges[1]!.params).toMatchObject({ fromId: 'ci-self', toId: 'ci-lb', sourceId: 'src-1' })
    expect(st.relationsCreated).toBe(2)
    // Both ends of every relation are reported to the service maps, once per batch.
    expect(notifyCIGraphChanged).toHaveBeenCalledWith('tenant-1', expect.arrayContaining(['ci-self', 'ci-db', 'ci-lb']), 'discovery.reconciled:src-1')
  })

  it('a relation that already existed is not counted as created again', async () => {
    const st = stats()
    relSession({ isNew: false })
    await reconcileBatch([ci({ relationships: [rel('db-1', 'DEPENDS_ON'), rel('lb-1', 'HOSTED_ON', 'incoming')] })], source, 'run-1', 'tenant-1', st)
    expect(st.relationsCreated).toBe(0)
  })

  it('relations the source no longer reports are removed, only those carrying this source marker', async () => {
    const s = relSession({ removed: 3 })
    const st = stats()
    await reconcileBatch([ci({ relationships: [rel('db-1', 'depends-on')] })], source, 'run-1', 'tenant-1', st)
    const del = s.calls.find((x) => x.cypher.includes('DELETE r'))!
    expect(del.cypher).toContain('WHERE r.discovery_source_id = $sourceId')
    // The relation type is normalised before it reaches the query text.
    expect(del.params).toEqual({ fromId: 'ci-self', sourceId: 'src-1', reported: [['DEPENDS_ON', 'ci-db', 'outgoing']] })
    expect(st.relationsRemoved).toBe(3)
  })

  it('a missing removal count reads as zero', async () => {
    const st = stats()
    relSession({ removed: null })
    await reconcileBatch([ci({ relationships: [rel('db-1', 'DEPENDS_ON')] })], source, 'run-1', 'tenant-1', st)
    expect(st.relationsRemoved).toBe(0)
  })

  it('a target not discovered by this source is skipped, and a type that is not a safe identifier never reaches Cypher', async () => {
    const s = relSession()
    await reconcileBatch([ci({ relationships: [rel('unknown', 'DEPENDS_ON'), rel('db-1', '9lives')] })], source, 'run-1', 'tenant-1', stats())
    expect(s.calls.some((x) => x.cypher.includes('MERGE (a)-[r:'))).toBe(false)
    // Nothing was reported, so the removal pass removes every relation of this source from the CI.
    expect(s.calls.find((x) => x.cypher.includes('DELETE r'))!.params['reported']).toEqual([])
  })

  it('if the CI itself cannot be found again, relations are left alone', async () => {
    const s = relSession({ selfMissing: true })
    const st = stats()
    await reconcileBatch([ci({ relationships: [rel('db-1', 'DEPENDS_ON')] })], source, 'run-1', 'tenant-1', st)
    expect(s.calls.some((x) => x.cypher.includes('MERGE (a)-[r:') || x.cypher.includes('DELETE r'))).toBe(false)
    expect(st).toMatchObject({ relationsCreated: 0, relationsRemoved: 0 })
  })
})
