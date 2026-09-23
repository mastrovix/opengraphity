/**
 * Discovery sync worker — the paths the first suite leaves out.
 *
 * Why it matters:
 *  - a scheduled (cron) job carries a fixed runId with no SyncRun node: the
 *    worker must create one per firing, or nightly syncs never appear on the
 *    Runs page and a failure leaves no trace;
 *  - a provider that never stops (or never answers) must not hold a worker
 *    slot forever: past the run timeout the run fails with a readable reason;
 *  - disabling a source or clearing its cron must remove its scheduler, or a
 *    deleted cron keeps firing forever from Redis;
 *  - one corrupt cron must not keep the tenant's other sources from being
 *    scheduled (since 23 Sep 2026 they are registered per tenant, in the
 *    tenant's own queue `discovery-sync@<tenant>`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Job } from 'bullmq'
import type { Connector, DiscoveredCI } from '@opengraphity/discovery'
import { resetConfigCache } from '../../lib/config.js'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const upsertScheduler = vi.fn().mockResolvedValue(undefined)
const removeScheduler = vi.fn().mockResolvedValue(true)
const getTenantQueue = vi.fn((_base: string, _tenantId: string) => ({ upsertJobScheduler: upsertScheduler, removeJobScheduler: removeScheduler }))
vi.mock('../../lib/bullmq.js', () => ({
  createTenantWorkers: vi.fn((name: string, processor: AnyProcessor) => {
    processors.set(name, processor)
    return { name }
  }),
  getTenantQueue: (base: string, tenantId: string) => getTenantQueue(base, tenantId),
}))

interface Rec { get(k: string): unknown }
type Tx = { run: (q: string, p?: Record<string, unknown>) => Promise<{ records: Rec[] }> }
type Work = (tx: Tx) => Promise<unknown>

const writes: Array<{ q: string; p: Record<string, unknown> }> = []
let readRows: Record<string, unknown>[] = []
const runQueryOne = vi.fn()
const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeWrite: async (work: Work) => work({ run: async (q, p) => { writes.push({ q, p: p ?? {} }); return { records: [] } } }),
    executeRead:  async (work: Work) => work({ run: async () => ({ records: readRows.map((r) => ({ get: (k: string) => r[k] ?? null })) }) }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
  runQuery: (...a: unknown[]) => runQuery(...a),
}))

const getConnector = vi.fn()
vi.mock('@opengraphity/discovery', () => ({
  getConnector: (t: string) => getConnector(t),
  decryptCredentials: () => ({ token: 'x' }),
}))

const reconcileBatch = vi.fn()
const markStale = vi.fn()
vi.mock('../reconciliationEngine.js', () => ({
  reconcileBatch: (...a: unknown[]) => reconcileBatch(...a),
  markStale: (...a: unknown[]) => markStale(...a),
}))
vi.mock('@opengraphity/events', () => ({ publish: vi.fn().mockResolvedValue(undefined) }))

const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() } }))

vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('DISCOVERY_ENCRYPTION_KEY', 'a'.repeat(64))
resetConfigCache()

const { startSyncWorker, scheduleTenantSyncs, scheduleSourceSync, scheduledSyncJobId } = await import('../syncWorker.js')
startSyncWorker()
const processor = processors.get('discovery-sync')!

const SOURCE_ROW = {
  props: { id: 'src-1', tenant_id: 't1', name: 'AWS', connector_type: 'mock', config: '{}', mapping_rules: '[]', enabled: true },
  enc: 'ENC',
}
const ci = (i: number): DiscoveredCI => ({ external_id: `ext-${i}`, source: 'mock', ci_type: 'server', name: `srv-${i}`, properties: {}, tags: {}, relationships: [] })
const connectorYielding = (cis: DiscoveredCI[], onYield?: (i: number) => void): Connector => ({
  type: 'mock', displayName: 'Mock', supportedCITypes: ['server'],
  async *scan() { let i = 0; for (const c of cis) { onYield?.(i++); yield c } },
  testConnection: async () => ({ ok: true, message: 'ok' }),
  getRequiredCredentialFields: () => [],
  getConfigFields: () => [],
})
const makeJob = (data: Record<string, unknown>) =>
  ({ id: 'j-1', name: 'sync', data: { runId: 'run-1', sourceId: 'src-1', tenantId: 't1', syncType: 'manual', ...data }, updateProgress: vi.fn() }) as unknown as Job

const runStatusWrites = () => writes.filter((w) => w.q.includes('MATCH (r:SyncRun')).map((w) => w.p)

beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  readRows = []
  runQuery.mockResolvedValue([])
  reconcileBatch.mockResolvedValue(undefined)
  markStale.mockResolvedValue(0)
  getConnector.mockReturnValue(connectorYielding([ci(1)]))
})

afterEach(() => { vi.restoreAllMocks() })

describe('processSyncJob — a scheduled job has no SyncRun yet', () => {
  it('creates one per firing, tenant-scoped, and writes the outcome on it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    // first lookup: the SyncRun (absent); second: the SyncSource
    runQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(SOURCE_ROW)
    await processor(makeJob({ runId: 'scheduled-src-1', syncType: 'scheduled' }))

    const create = runQuery.mock.calls.find((c) => String(c[1]).includes('CREATE (r:SyncRun'))!
    // a unique id per firing: the fixed cron runId alone would collide every night
    expect(create[2]).toEqual({
      id: 'scheduled-src-1-1700000000000', sourceId: 'src-1', tenantId: 't1', syncType: 'scheduled',
      now: new Date(1_700_000_000_000).toISOString(),
    })
    const statuses = runStatusWrites()
    expect(statuses.map((p) => p['runId'])).toEqual(['scheduled-src-1-1700000000000', 'scheduled-src-1-1700000000000'])
    expect(statuses.map((p) => p['status'])).toEqual(['running', 'completed'])
    expect(statuses.every((p) => p['tenantId'] === 't1')).toBe(true)
  })

  it('a job without syncType is recorded as scheduled', async () => {
    runQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(SOURCE_ROW)
    await processor(makeJob({ runId: 'scheduled-src-1', syncType: undefined }))
    const create = runQuery.mock.calls.find((c) => String(c[1]).includes('CREATE (r:SyncRun'))!
    expect((create[2] as Record<string, unknown>)['syncType']).toBe('scheduled')
  })

  it('a manual job whose SyncRun exists does not create a second one', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'run-1' }).mockResolvedValueOnce(SOURCE_ROW)
    await processor(makeJob({}))
    expect(runQuery.mock.calls.some((c) => String(c[1]).includes('CREATE (r:SyncRun'))).toBe(false)
    expect(runStatusWrites().map((p) => p['runId'])).toEqual(['run-1', 'run-1'])
  })
})

describe('processSyncJob — run timeout', () => {
  it('a provider still streaming after 30 minutes fails the run with a readable reason and frees the slot', async () => {
    const t0 = 1_700_000_000_000
    let now = t0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    runQueryOne.mockResolvedValueOnce({ id: 'run-1' }).mockResolvedValueOnce(SOURCE_ROW)
    // the second CI arrives 31 minutes after the start
    getConnector.mockReturnValue(connectorYielding([ci(1), ci(2), ci(3)], (i) => { if (i === 1) now = t0 + 31 * 60_000 }))

    await expect(processor(makeJob({}))).rejects.toThrow(/stopped after 30 minutes: the "mock" provider is still sending data.*1 CIs were reconciled/)
    const failed = runStatusWrites().find((p) => p['status'] === 'failed')!
    expect(failed['errorMsg']).toMatch(/stopped after 30 minutes/)
    // The run stops between two CIs, but what was read is written first: the
    // CI counted as reconciled in the message really was (until 23 Sep 2026
    // the partial batch was dropped and the count was of CIs merely read).
    expect(reconcileBatch).toHaveBeenCalledTimes(1)
    expect((reconcileBatch.mock.calls[0]![0] as Array<{ external_id: string }>).map((c) => c.external_id)).toEqual([ci(1).external_id])
  })
})

describe('scheduleSourceSync', () => {
  it.each([
    [{ enabled: false, cron: '0 * * * *' }],
    [{ enabled: true, cron: null }],
  ])('%j removes the scheduler and registers nothing', async (over) => {
    await scheduleSourceSync({ id: 'src-1', tenantId: 't1', ...over })
    expect(removeScheduler).toHaveBeenCalledWith(scheduledSyncJobId('src-1'))
    expect(upsertScheduler).not.toHaveBeenCalled()
  })

  it('an enabled source with cron replaces its single scheduler, carrying its tenant, in its tenant\'s queue', async () => {
    await scheduleSourceSync({ id: 'src-1', tenantId: 't1', cron: '0 3 * * *', enabled: true })
    expect(getTenantQueue).toHaveBeenCalledWith('discovery-sync', 't1')
    expect(removeScheduler).toHaveBeenCalledWith('sync-scheduled-src-1')
    expect(upsertScheduler).toHaveBeenCalledWith('sync-scheduled-src-1', { pattern: '0 3 * * *' }, expect.objectContaining({
      data: { runId: 'scheduled-src-1', sourceId: 'src-1', tenantId: 't1', syncType: 'scheduled' },
    }))
  })
})

describe('scheduleTenantSyncs — one corrupt cron', () => {
  it('is logged and the tenant\'s other sources are still registered', async () => {
    readRows = [
      { id: 'bad', cron: 'not a cron' },
      { id: 'good', cron: '0 3 * * *' },
    ]
    upsertScheduler.mockImplementation(async (jobId: string) => { if (jobId === 'sync-scheduled-bad') throw new Error('Invalid cron') })
    await expect(scheduleTenantSyncs(null, 't1')).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', sourceId: 'bad', cron: 'not a cron' }), expect.stringContaining('NOT registered'))
    expect(upsertScheduler).toHaveBeenCalledWith('sync-scheduled-good', { pattern: '0 3 * * *' }, expect.anything())
  })
})
