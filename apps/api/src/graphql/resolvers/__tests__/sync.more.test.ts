/**
 * sync.ts — the discovery admin surface beyond credentials (those live in
 * sync.test.ts): run history, conflict queue, stats, change history, the
 * connector catalogue, delete, triggerSync on a foreign source, conflict
 * resolution and the connection test.
 *
 * Why these matter to a user:
 *  - every read is tenant-scoped: a sync admin of one customer must never see
 *    another customer's runs, conflicts or CI change records;
 *  - the sort whitelist keeps user input out of the Cypher ORDER BY;
 *  - triggerSync on a source that is not in the tenant must fail BEFORE a
 *    `queued` run is written, or the run list shows a run "in queue" forever;
 *  - resolving a conflict must create/update a CI with the SAME shape the
 *    reconciliation engine writes (type, discovery_source_id, flattened
 *    properties), otherwise the next sync does not recognise it and
 *    duplicates it; an "unknown CI type" conflict must not be resolvable here;
 *  - deleting a source must drop its Redis cron, or it fires forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const txRun = vi.fn()
const mockSession = {
  executeRead:  vi.fn(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun })),
  executeWrite: vi.fn(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun })),
  close: vi.fn(),
}

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('@opengraphity/discovery', () => ({
  encryptCredentials: vi.fn().mockReturnValue('ENC:opaque'),
  decryptCredentials: vi.fn().mockReturnValue({ token: 'plain' }),
  getAllConnectors:   vi.fn().mockReturnValue([]),
  getConnector:       vi.fn(),
  // Same contract as the real one for what matters here: null/empty dropped.
  normalizeProperties: (p: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== '')),
}))
vi.mock('../../../discovery/syncWorker.js', () => ({
  syncQueue: { add: vi.fn().mockResolvedValue({ id: 'job-1' }) },
  scheduleSourceSync: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../discovery/reconciliationEngine.js', () => ({
  CONFLICT_LOCKED_FIELDS: 'locked_fields',
  CONFLICT_UNKNOWN_CI_TYPE: 'unknown_ci_type',
}))
vi.mock('../../../discovery/ciTypeResolution.js', () => ({
  CITypeResolver: { forSource: vi.fn() },
}))
vi.mock('../../../lib/ciLifecycle.js', () => ({ initialCIStatus: vi.fn().mockResolvedValue('in_service') }))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ notifyCIGraphChanged: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))

const { syncResolvers } = await import('../sync.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { getAllConnectors, getConnector, decryptCredentials } = await import('@opengraphity/discovery')
const { syncQueue, scheduleSourceSync } = await import('../../../discovery/syncWorker.js')
const { CITypeResolver } = await import('../../../discovery/ciTypeResolution.js')
const { notifyCIGraphChanged } = await import('../../../services/serviceImpact/sync.js')
const { audit } = await import('../../../lib/audit.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }

function record(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] }
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks keeps queued *Once values: a test that stops early must not
  // leak its unread rows into the next one.
  vi.mocked(runQuery).mockReset()
  vi.mocked(runQueryOne).mockReset()
  txRun.mockReset()
  txRun.mockResolvedValue({ records: [] })
})

// ── Queries ──────────────────────────────────────────────────────────────────

describe('syncRuns', () => {
  it('scopes by source AND tenant, maps counters and defaults nullable fields to null', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { p: { id: 'r1', source_id: 's1', tenant_id: 'tenant-1', sync_type: 'full', status: 'completed', ci_created: 3, ci_updated: 2,
        duration_ms: 1500, error_message: 'partial', started_at: 'a', completed_at: 'b' }, total: 7 },
      { p: { id: 'r2', source_id: 's1', tenant_id: 'tenant-1', sync_type: 'manual', status: 'queued', started_at: 'c' }, total: 7 },
    ] as never)

    const out = await syncResolvers.Query.syncRuns(null, { sourceId: 's1' }, ctx)

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (n:SyncRun {source_id: $sourceId, tenant_id: $tenantId})')
    expect(cypher).toContain('ORDER BY n.started_at DESC')
    expect(params).toEqual({ sourceId: 's1', tenantId: 'tenant-1', offset: 0, limit: 20 })
    expect(out.total).toBe(7)
    expect(out.items[0]).toMatchObject({ ciCreated: 3, ciUpdated: 2, ciStale: 0, durationMs: 1500, errorMessage: 'partial', completedAt: 'b' })
    // A queued run has no duration/completion yet: null, not 0 or "".
    expect(out.items[1]).toMatchObject({ durationMs: null, errorMessage: null, completedAt: null })
  })

  it('sorts only by whitelisted columns; an unknown field falls back to started_at DESC', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)

    await syncResolvers.Query.syncRuns(null, { sourceId: 's1', sortField: 'durationMs', sortDirection: 'asc', limit: 5, offset: 10 }, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toContain('ORDER BY n.duration_ms ASC')
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ limit: 5, offset: 10 })

    await syncResolvers.Query.syncRuns(null, { sourceId: 's1', sortField: 'status' }, ctx)
    expect(vi.mocked(runQuery).mock.calls[1]![1]).toContain('ORDER BY n.status DESC')

    // Injection attempt: never interpolated into the query.
    const out = await syncResolvers.Query.syncRuns(null, { sourceId: 's1', sortField: 'x; DETACH DELETE n' }, ctx)
    expect(vi.mocked(runQuery).mock.calls[2]![1]).not.toContain('DETACH DELETE')
    expect(vi.mocked(runQuery).mock.calls[2]![1]).toContain('ORDER BY n.started_at DESC')
    expect(out).toEqual({ items: [], total: 0 })
  })
})

describe('syncConflicts', () => {
  it('always filters by tenant; source and status filters are optional parameters, not interpolated values', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await syncResolvers.Query.syncConflicts(null, {}, ctx)
    let [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('WHERE n.tenant_id = $tenantId\n')
    expect(params).toEqual({ tenantId: 'tenant-1', offset: 0, limit: 20 })

    vi.mocked(runQuery).mockResolvedValueOnce([
      { p: { id: 'c1', source_id: 's1', tenant_id: 'tenant-1', status: 'open', external_id: 'i-1', ci_type: 'server' }, total: 1 },
    ] as never)
    const out = await syncResolvers.Query.syncConflicts(null, { sourceId: 's1', status: 'open', limit: 2, offset: 4 }, ctx)
    ;[, cypher, params] = vi.mocked(runQuery).mock.calls[1]!
    expect(cypher).toContain('n.tenant_id = $tenantId AND n.source_id = $sourceId AND n.status = $status')
    expect(params).toEqual({ tenantId: 'tenant-1', sourceId: 's1', status: 'open', offset: 4, limit: 2 })
    expect(out.total).toBe(1)
    // Conflicts written before `conflict_kind` existed were all locked-field ones.
    expect(out.items[0]).toMatchObject({ kind: 'locked_fields', conflictFields: '[]', discoveredCi: '{}', message: null, resolution: null, resolvedAt: null })
  })
})

describe('syncStats', () => {
  it('computes the success rate rounded to two decimals, all scoped by tenant', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{
      totalSources: 3, enabledSources: 2, lastSyncAt: '2026-09-01', ciManaged: 40, openConflicts: 5, totalRuns: 3, successRuns: 2,
    }] as never)
    const out = await syncResolvers.Query.syncStats(null, {}, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ tenantId: 'tenant-1' })
    expect(out).toEqual({ totalSources: 3, enabledSources: 2, lastSyncAt: '2026-09-01', ciManaged: 40, openConflicts: 5, totalRuns: 3, successRate: 0.67 })
  })

  it('no rows / no runs → zeros and a 0 rate, not NaN', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    const out = await syncResolvers.Query.syncStats(null, {}, ctx)
    expect(out).toEqual({ totalSources: 0, enabledSources: 0, lastSyncAt: null, ciManaged: 0, openConflicts: 0, totalRuns: 0, successRate: 0 })
  })
})

describe('syncChangeHistory', () => {
  it('reads change records of the CI in this tenant only, with defaults for missing JSON fields', async () => {
    txRun
      .mockResolvedValueOnce({ records: [
        record({ p: { id: 'h1', ci_id: 'ci1', source_id: 's1', tenant_id: 'tenant-1', changed_at: 't', changed_fields: '["ip"]', old_values: '{"ip":"1"}', new_values: '{"ip":"2"}' } }),
        record({ p: { id: 'h2', ci_id: 'ci1', source_id: 's1', tenant_id: 'tenant-1', changed_at: 't2' } }),
      ] })
      .mockResolvedValueOnce({ records: [record({ cnt: 12 })] })

    const out = await syncResolvers.Query.syncChangeHistory(null, { ciId: 'ci1', limit: 2, offset: 0 }, ctx)

    expect(txRun.mock.calls[0]![0]).toContain('SyncChangeRecord {ci_id: $ciId, tenant_id: $tenantId}')
    expect(txRun.mock.calls[0]![1]).toEqual({ ciId: 'ci1', tenantId: 'tenant-1', offset: 0, limit: 2 })
    expect(txRun.mock.calls[1]![1]).toEqual({ ciId: 'ci1', tenantId: 'tenant-1' })
    expect(out.total).toBe(12)
    expect(out.items[0]).toMatchObject({ changedFields: '["ip"]', newValues: '{"ip":"2"}' })
    expect(out.items[1]).toMatchObject({ changedFields: '[]', oldValues: '{}', newValues: '{}' })
  })

  it('no count row → total 0 and default page', async () => {
    txRun.mockResolvedValue({ records: [] })
    const out = await syncResolvers.Query.syncChangeHistory(null, { ciId: 'ci1' }, ctx)
    expect(txRun.mock.calls[0]![1]).toMatchObject({ offset: 0, limit: 50 })
    expect(out).toEqual({ items: [], total: 0 })
  })
})

describe('availableConnectors', () => {
  it('describes each connector with nullable optional metadata and stringified defaults', () => {
    vi.mocked(getAllConnectors).mockReturnValueOnce([{
      type: 'aws', displayName: 'AWS', supportedCITypes: ['server'],
      getRequiredCredentialFields: () => [
        { name: 'key', label: 'Key', type: 'password', required: true, placeholder: 'AKIA…', help_text: 'IAM key' },
        { name: 'region', label: 'Region', type: 'text', required: false },
      ],
      getConfigFields: () => [
        { name: 'depth', label: 'Depth', type: 'number', required: false, default_value: 3, options: ['1', '3'], help_text: 'h' },
        { name: 'flag', label: 'Flag', type: 'boolean', required: false },
      ],
    }] as never)

    const [c] = syncResolvers.Query.availableConnectors(null, null, ctx)
    expect(c).toMatchObject({ type: 'aws', displayName: 'AWS', supportedCITypes: ['server'] })
    expect(c!.credentialFields).toEqual([
      { name: 'key', label: 'Key', type: 'password', required: true, placeholder: 'AKIA…', helpText: 'IAM key', options: null, defaultValue: null },
      { name: 'region', label: 'Region', type: 'text', required: false, placeholder: null, helpText: null, options: null, defaultValue: null },
    ])
    // The web form expects a string default (the value lands in an <input>).
    expect(c!.configFields[0]).toMatchObject({ defaultValue: '3', options: ['1', '3'], helpText: 'h' })
    expect(c!.configFields[1]).toMatchObject({ defaultValue: null, options: null, helpText: null })
  })
})

// ── Mutations ────────────────────────────────────────────────────────────────

describe('create/update keep the Redis cron in step with the source', () => {
  const ORIGINAL_KEY = process.env['DISCOVERY_ENCRYPTION_KEY']
  beforeEach(() => { process.env['DISCOVERY_ENCRYPTION_KEY'] = 'k' })
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['DISCOVERY_ENCRYPTION_KEY']
    else process.env['DISCOVERY_ENCRYPTION_KEY'] = ORIGINAL_KEY
  })

  it('createSyncSource schedules the cron of the stored source', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ p: { id: 'new', tenant_id: 'tenant-1', schedule_cron: '0 * * * *', enabled: true, last_sync_duration_ms: 10 } } as never)
    const out = await syncResolvers.Mutation.createSyncSource(null, { input: {
      name: 'n', connectorType: 'aws', credentials: '{}', config: '{}', mappingRules: '[{"a":1}]', scheduleCron: '0 * * * *', enabled: true,
    } }, ctx)
    expect(scheduleSourceSync).toHaveBeenCalledWith({ id: expect.any(String), tenantId: 'tenant-1', cron: '0 * * * *', enabled: true })
    expect(out.lastSyncDurationMs).toBe(10)
  })

  it('updateSyncSource validates a new cron, then reschedules; a disabled source unschedules', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ p: { id: 's1', schedule_cron: '*/5 * * * *', enabled: false } } as never)
    await syncResolvers.Mutation.updateSyncSource(null, { id: 's1', input: { config: '{"x":1}', mappingRules: '[]', scheduleCron: '*/5 * * * *', enabled: false } }, ctx)
    const [cypher, params] = txRun.mock.calls.at(-1)! as [string, Record<string, unknown>]
    expect(cypher).toContain('n.config = $config')
    expect(cypher).toContain('n.mapping_rules = $mappingRules')
    expect(cypher).toContain('n.schedule_cron = $scheduleCron')
    expect(params).toMatchObject({ tenantId: 'tenant-1', scheduleCron: '*/5 * * * *', enabled: false })
    expect(scheduleSourceSync).toHaveBeenCalledWith({ id: 's1', tenantId: 'tenant-1', cron: '*/5 * * * *', enabled: false })

    // An invalid cron is refused before anything is written (it would block API start-up).
    await expect(syncResolvers.Mutation.updateSyncSource(null, { id: 's1', input: { scheduleCron: 'every hour' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(mockSession.executeWrite).toHaveBeenCalledTimes(1)
  })
})

describe('deleteSyncSource', () => {
  it('deletes only in the tenant and drops the Redis cron (no orphan job firing forever)', async () => {
    await expect(syncResolvers.Mutation.deleteSyncSource(null, { id: 's1' }, ctx)).resolves.toBe(true)
    expect(txRun).toHaveBeenCalledWith(expect.stringContaining('MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) DETACH DELETE n'), { id: 's1', tenantId: 'tenant-1' })
    expect(scheduleSourceSync).toHaveBeenCalledWith({ id: 's1', tenantId: 'tenant-1', cron: null, enabled: false })
    expect(audit).toHaveBeenCalledWith(ctx, 'sync_source.deleted', 'SyncSource', 's1')
  })
})

describe('triggerSync on a source outside the tenant', () => {
  it('fails with NotFound BEFORE a queued run is written or a job enqueued', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(syncResolvers.Mutation.triggerSync(null, { sourceId: 's-other' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ sourceId: 's-other', tenantId: 'tenant-1' })
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(syncQueue.add).not.toHaveBeenCalled()
  })
})

describe('resolveConflict', () => {
  const DISCOVERED = {
    name: 'web-01', external_id: 'i-123', source: 'aws',
    properties: { ip_address: '10.0.0.1', empty: '', id: 'hijack', tenant_id: 'other', discovery_status: 'x', discovered_at: 'y' },
    tags: { env: 'prod' },
  }
  function conflict(extra: Record<string, unknown> = {}) {
    return { p: { id: 'c1', source_id: 's1', tenant_id: 'tenant-1', run_id: 'r1', external_id: 'i-123', ci_type: 'server',
      conflict_kind: 'locked_fields', status: 'open', discovered_ci: JSON.stringify(DISCOVERED), existing_ci_id: 'ci-old', ...extra } }
  }
  const resolve = vi.fn()

  beforeEach(() => {
    resolve.mockReturnValue({ ok: true, type: { name: 'server', label: 'Server' } })
    vi.mocked(CITypeResolver.forSource).mockResolvedValue({ resolve } as never)
  })

  function queueReads(conflictRow: unknown, rules: unknown = { rules: '[{"alias":"x"}]' }, reread: unknown = { p: { id: 'c1', status: 'resolved', resolution: 'merged', resolved_at: 'now' } }) {
    vi.mocked(runQueryOne).mockResolvedValueOnce(conflictRow as never).mockResolvedValueOnce(rules as never).mockResolvedValueOnce(reread as never)
  }

  it('unknown conflict in the tenant → NotFound, nothing written', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c-x', resolution: 'merged' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'c-x', tenantId: 'tenant-1' })
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('an "unknown CI type" conflict is not resolvable here: it would invent a label the metamodel rejected', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(conflict({ conflict_kind: 'unknown_ci_type', ci_type: 'Bilanciatore', message: 'Not a type.' }) as never)
    await expect(syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'distinct' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.sync.unknownCIType' } } })
    // Without a stored message the error still names the type and the fix.
    vi.mocked(runQueryOne).mockResolvedValueOnce(conflict({ conflict_kind: 'unknown_ci_type', ci_type: 'Bilanciatore' }) as never)
    await expect(syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'merged' }, ctx))
      .rejects.toThrow(/"Bilanciatore" is not a CI type of this tenant\. {2}Fix it at the root/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('a CI type the tenant cannot resolve → ValidationError with the resolver reason', async () => {
    queueReads(conflict())
    resolve.mockReturnValueOnce({ ok: false, reason: 'type gone' })
    await expect(syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'distinct' }, ctx))
      .rejects.toThrow(/cannot be resolved: type gone/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('merged: updates the existing CI with the engine shape and flattened props; reserved names cannot be overwritten', async () => {
    queueReads(conflict())
    const out = await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'merged' }, ctx)

    // The resolver is built from THIS source's mapping rules, read in the tenant.
    expect(vi.mocked(runQueryOne).mock.calls[1]![2]).toEqual({ sourceId: 's1', tenantId: 'tenant-1' })
    expect(CITypeResolver.forSource).toHaveBeenCalledWith('tenant-1', { mapping_rules: [{ alias: 'x' }] })

    const [cypher, params] = txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('MATCH (ci:ConfigurationItem {id: $existingCiId, tenant_id: $tenantId})')
    expect(cypher).toContain('ci.discovery_source_id = $sourceId')
    expect(cypher).toContain('ci.name = $discoveredName')
    expect(params).toMatchObject({ existingCiId: 'ci-old', tenantId: 'tenant-1', sourceId: 's1', externalId: 'i-123', source: 'aws', discoveredName: 'web-01' })
    // id/tenant_id/discovery_* from the payload must not overwrite structural fields.
    expect(params['props']).toEqual({ ip_address: '10.0.0.1', env: 'prod' })

    const [markCypher, markParams] = txRun.mock.calls[1]! as [string, Record<string, unknown>]
    expect(markCypher).toContain("SET c.status = 'resolved'")
    expect(markParams).toMatchObject({ id: 'c1', tenantId: 'tenant-1', resolution: 'merged' })
    expect(vi.mocked(runQueryOne).mock.calls[2]![2]).toEqual({ id: 'c1', tenantId: 'tenant-1' })
    expect(out).toMatchObject({ id: 'c1', status: 'resolved', resolution: 'merged', resolvedAt: 'now' })
    expect(audit).toHaveBeenCalledWith(ctx, 'sync_conflict.resolved', 'SyncConflict', 'c1', { resolution: 'merged' })
  })

  it('merged without a discovered name does not blank the CI name; missing rules default to []', async () => {
    const bare = { external_id: undefined }
    queueReads(conflict({ discovered_ci: JSON.stringify(bare) }), null)
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'merged' }, ctx)
    expect(CITypeResolver.forSource).toHaveBeenCalledWith('tenant-1', { mapping_rules: [] })
    const [cypher, params] = txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).not.toContain('ci.name =')
    expect(params).toMatchObject({ source: '', externalId: '', discoveredName: '', props: {} })
  })

  it('distinct: creates a new CI with the RESOLVED label/type and the tenant initial status', async () => {
    queueReads(conflict())
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'distinct' }, ctx)
    const [cypher, params] = txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('CREATE (ci:ConfigurationItem:Server {')
    expect(cypher).toContain('discovery_source_id: $sourceId')
    expect(params).toMatchObject({ tenantId: 'tenant-1', name: 'web-01', ciType: 'server', initialStatus: 'in_service', externalId: 'i-123' })
    expect(notifyCIGraphChanged).not.toHaveBeenCalled()
  })

  it('distinct: name falls back to the external id, then to "Unknown"', async () => {
    queueReads(conflict({ discovered_ci: JSON.stringify({ external_id: 'i-9' }) }))
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'distinct' }, ctx)
    expect(txRun.mock.calls[0]![1]).toMatchObject({ name: 'i-9', source: '' })

    vi.clearAllMocks()
    txRun.mockResolvedValue({ records: [] })
    vi.mocked(CITypeResolver.forSource).mockResolvedValue({ resolve } as never)
    queueReads(conflict({ discovered_ci: '{}' }))
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'distinct' }, ctx)
    expect(txRun.mock.calls[0]![1]).toMatchObject({ name: 'Unknown', externalId: '' })
  })

  it('linked: creates the CI, links both ways inside the tenant and notifies the service-map engine', async () => {
    queueReads(conflict())
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'linked' }, ctx)
    const [cypher, params] = txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('CREATE (ci:ConfigurationItem:Server {')
    expect(cypher).toContain('MATCH (existing:ConfigurationItem {id: $existingCiId, tenant_id: $tenantId})')
    expect(cypher).toContain('MERGE (existing)-[:RELATED_TO {created_at: $now}]->(ci)')
    expect(params).toMatchObject({ existingCiId: 'ci-old', tenantId: 'tenant-1', ciType: 'server' })
    expect(notifyCIGraphChanged).toHaveBeenCalledWith('tenant-1', [params['newCiId'], 'ci-old'], 'sync_conflict.linked')
  })

  it('linked: name falls back to the external id, then to "Unknown"', async () => {
    queueReads(conflict({ discovered_ci: JSON.stringify({ external_id: 'i-7' }) }))
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'linked' }, ctx)
    expect(txRun.mock.calls[0]![1]).toMatchObject({ name: 'i-7', source: '' })

    vi.clearAllMocks()
    txRun.mockResolvedValue({ records: [] })
    vi.mocked(CITypeResolver.forSource).mockResolvedValue({ resolve } as never)
    queueReads(conflict({ discovered_ci: '{}' }))
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'linked' }, ctx)
    expect(txRun.mock.calls[0]![1]).toMatchObject({ name: 'Unknown', externalId: '' })
  })

  it('an unrecognised resolution only marks the conflict (no CI write)', async () => {
    queueReads(conflict())
    await syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'ignored' }, ctx)
    expect(txRun).toHaveBeenCalledTimes(1)
    expect(txRun.mock.calls[0]![0]).toContain("SET c.status = 'resolved'")
  })

  it('conflict vanished during resolution (tenant-scoped re-read empty) → NotFound, no audit', async () => {
    queueReads(conflict(), { rules: '[]' }, null)
    await expect(syncResolvers.Mutation.resolveConflict(null, { conflictId: 'c1', resolution: 'merged' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('testSyncConnection', () => {
  const ORIGINAL_KEY = process.env['DISCOVERY_ENCRYPTION_KEY']
  beforeEach(() => { process.env['DISCOVERY_ENCRYPTION_KEY'] = 'the-key' })
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['DISCOVERY_ENCRYPTION_KEY']
    else process.env['DISCOVERY_ENCRYPTION_KEY'] = ORIGINAL_KEY
  })

  const SOURCE = { id: 's1', tenant_id: 'tenant-1', name: 'AWS', connector_type: 'aws', config: '{"region":"eu"}', mapping_rules: '[]', enabled: true, created_at: 'c', updated_at: 'u' }

  it('unregistered connector → ok:false with the connector name, credentials never decrypted', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ p: SOURCE } as never)
    vi.mocked(getConnector).mockReturnValueOnce(undefined as never)
    await expect(syncResolvers.Mutation.testSyncConnection(null, { sourceId: 's1' }, ctx))
      .resolves.toEqual({ ok: false, message: 'Connector "aws" not registered', details: null })
    expect(decryptCredentials).not.toHaveBeenCalled()
  })

  it('decrypts with the env key, passes the parsed config and returns details as JSON', async () => {
    const testConnection = vi.fn().mockResolvedValue({ ok: true, message: 'fine', details: { regions: 2 } })
    vi.mocked(getConnector).mockReturnValue({ testConnection } as never)
    vi.mocked(runQueryOne)
      .mockResolvedValueOnce({ p: { ...SOURCE, schedule_cron: '0 * * * *', last_sync_at: 'l', last_sync_status: 'completed', last_sync_duration_ms: 9 } } as never)
      .mockResolvedValueOnce({ enc: 'ENC:blob' } as never)

    const out = await syncResolvers.Mutation.testSyncConnection(null, { sourceId: 's1' }, ctx)

    expect(vi.mocked(runQueryOne).mock.calls[1]![2]).toEqual({ id: 's1', tenantId: 'tenant-1' })
    expect(decryptCredentials).toHaveBeenCalledWith('ENC:blob', 'the-key')
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1', tenant_id: 'tenant-1', config: { region: 'eu' }, mapping_rules: [], schedule_cron: '0 * * * *', last_sync_status: 'completed', last_sync_duration_ms: 9,
    }), { token: 'plain' })
    expect(out).toEqual({ ok: true, message: 'fine', details: '{"regions":2}' })
  })

  it('no details from the connector → details null', async () => {
    vi.mocked(getConnector).mockReturnValue({ testConnection: vi.fn().mockResolvedValue({ ok: false, message: 'denied' }) } as never)
    vi.mocked(runQueryOne).mockResolvedValueOnce({ p: SOURCE } as never).mockResolvedValueOnce({ enc: 'E' } as never)
    await expect(syncResolvers.Mutation.testSyncConnection(null, { sourceId: 's1' }, ctx)).resolves.toEqual({ ok: false, message: 'denied', details: null })
  })
})

describe('mapSource tolerates non-string stored values', () => {
  it('numbers/booleans stored in string columns are stringified, missing ones become ""', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ p: { id: 42, name: undefined, enabled: 0 } } as never)
    const out = await syncResolvers.Query.syncSource(null, { id: '42' }, ctx)
    expect(out).toMatchObject({ id: '42', name: '', mappingRules: '[]', enabled: false, scheduleCron: null })
  })
})
