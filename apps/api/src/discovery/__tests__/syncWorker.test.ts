/**
 * Discovery sync job (discovery/syncWorker.ts → processSyncJob, captured from
 * createTenantWorkers): a mock connector streams N resources → batches
 * reconciled, stats written on the SyncRun (tenant-scoped) and the SyncSource;
 * a connector that throws marks the run `failed` with the message AND rethrows
 * (BullMQ retry). Since 23 Sep 2026 every tenant has its own queue
 * `discovery-sync@<tenant>`, and its scheduled syncs are registered there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'
import type { Connector, DiscoveredCI, SyncSourceConfig } from '@opengraphity/discovery'
import type { ReconciliationStats } from '../reconciliationEngine.js'
import { resetConfigCache } from '../../lib/config.js'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const poolOptions = new Map<string, { concurrency?: number; schedule?: unknown }>()
/*
 * `upsertJobScheduler` nel finto (21 set 2026, BullMQ 6): le ricorrenze non
 * passano piu' da `add({ repeat })` — quella API non esiste piu' — ma da un
 * Job Scheduler con identita' esplicita. Il finto deve esporre quello che il
 * codice chiama davvero, se no il test prova un cammino che non esiste.
 */
const upsertScheduler = vi.fn().mockResolvedValue(undefined)
const removeScheduler = vi.fn().mockResolvedValue(true)
const getTenantQueue = vi.fn((_base: string, _tenantId: string) => ({ upsertJobScheduler: upsertScheduler, removeJobScheduler: removeScheduler }))
vi.mock('../../lib/bullmq.js', () => ({
  createTenantWorkers: vi.fn((name: string, processor: AnyProcessor, opts: { concurrency?: number; schedule?: unknown }) => {
    processors.set(name, processor)
    poolOptions.set(name, opts)
    return { name, opts }
  }),
  getTenantQueue: (base: string, tenantId: string) => getTenantQueue(base, tenantId),
}))

interface Rec { get(k: string): unknown }
type Tx = { run: (q: string, p?: Record<string, unknown>) => Promise<{ records: Rec[] }> }
type Work = (tx: Tx) => Promise<unknown>

const writes: Array<{ q: string; p: Record<string, unknown> }> = []
const reads: Array<{ q: string; p: Record<string, unknown> }> = []
let readRows: Record<string, unknown>[] = []
let readError: Error | null = null
const close = vi.fn().mockResolvedValue(undefined)
const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeWrite: async (work: Work) => work({ run: async (q, p) => { writes.push({ q, p: p ?? {} }); return { records: [] } } }),
    executeRead:  async (work: Work) => work({ run: async (q, p) => { reads.push({ q, p: p ?? {} }); if (readError) throw readError; return { records: readRows.map((r) => ({ get: (k: string) => r[k] ?? null })) } } }),
    close,
  })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
  runQuery: (...a: unknown[]) => runQuery(...a),
}))

const runQuery = vi.fn().mockResolvedValue([])
const getConnector = vi.fn()
const decryptCredentials = vi.fn()
vi.mock('@opengraphity/discovery', () => ({
  getConnector: (t: string) => getConnector(t),
  decryptCredentials: (enc: string, key: string) => decryptCredentials(enc, key),
}))

const reconcileBatch = vi.fn()
const markStale = vi.fn()
vi.mock('../reconciliationEngine.js', () => ({
  reconcileBatch: (...a: unknown[]) => reconcileBatch(...a),
  markStale: (...a: unknown[]) => markStale(...a),
}))

const publish = vi.fn()
vi.mock('@opengraphity/events', () => ({ publish: (...a: unknown[]) => publish(...a) }))

const logError = vi.fn()
const logWarn = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() },
}))

vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('DISCOVERY_ENCRYPTION_KEY', 'a'.repeat(64))
resetConfigCache()

const { startSyncWorker, scheduleTenantSyncs, DISCOVERY_SYNC_QUEUE } = await import('../syncWorker.js')

startSyncWorker()
const processor = processors.get('discovery-sync')!

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SOURCE_ROW = {
  props: {
    id: 'src-1', tenant_id: 't1', name: 'AWS prod', connector_type: 'mock', config: '{"region":"eu-south-1"}',
    mapping_rules: '[]', schedule_cron: null, enabled: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  enc: 'ENCRYPTED-BLOB',
}

const ci = (i: number): DiscoveredCI => ({ external_id: `ext-${i}`, source: 'mock', ci_type: 'server', name: `srv-${i}`, properties: {}, tags: {}, relationships: [] })

function connectorYielding(cis: DiscoveredCI[], failAfter?: { count: number; error: Error }): Connector {
  return {
    type: 'mock', displayName: 'Mock', supportedCITypes: ['server'],
    async *scan() {
      let n = 0
      for (const c of cis) {
        if (failAfter && n === failAfter.count) throw failAfter.error
        n++
        yield c
      }
    },
    testConnection: async () => ({ ok: true, message: 'ok' }),
    getRequiredCredentialFields: () => [],
    getConfigFields: () => [],
  }
}

const makeJob = (over: Record<string, unknown> = {}) => {
  const updateProgress = vi.fn().mockResolvedValue(undefined)
  const job = { id: 'j-1', name: 'sync', data: { runId: 'run-1', sourceId: 'src-1', tenantId: 't1', syncType: 'manual', ...over }, updateProgress } as unknown as Job
  return { job, updateProgress }
}

const runWrites = () => writes.filter((w) => w.q.includes('MATCH (r:SyncRun'))
const sourceWrites = () => writes.filter((w) => w.q.includes('MATCH (n:SyncSource'))

beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  reads.length = 0
  readRows = []
  readError = null
  runQueryOne.mockResolvedValue(SOURCE_ROW)
  decryptCredentials.mockReturnValue({ token: 'secret' })
  reconcileBatch.mockImplementation(async (batch: DiscoveredCI[], _src: SyncSourceConfig, _run: string, _t: string, stats: ReconciliationStats) => {
    stats.ciCreated += batch.length
  })
  markStale.mockResolvedValue(0)
  publish.mockResolvedValue(undefined)
})

// ── Happy path ───────────────────────────────────────────────────────────────

describe('processSyncJob — connettore che restituisce N risorse', () => {
  it('3 risorse → un batch riconciliato, stale marcati, SyncRun completed con statistiche e tenant_id', async () => {
    getConnector.mockReturnValue(connectorYielding([ci(1), ci(2), ci(3)]))
    markStale.mockResolvedValue(2)
    const { job, updateProgress } = makeJob()

    await expect(processor(job)).resolves.toBeUndefined()

    // Revisione totale · D-5: prima si assicura il nodo dell'esecuzione (qui
    // esiste già: l'ha creato la mutation), poi si legge la sorgente, scopata per tenant.
    expect(runQueryOne.mock.calls[0]![1]).toContain('MATCH (r:SyncRun {id: $runId, tenant_id: $tenantId})')
    expect(runQueryOne.mock.calls[1]![1]).toContain('MATCH (s:SyncSource {id: $id, tenant_id: $tenantId})')
    expect(runQueryOne.mock.calls[1]![2]).toEqual({ id: 'src-1', tenantId: 't1' })
    expect(getConnector).toHaveBeenCalledWith('mock')
    expect(decryptCredentials).toHaveBeenCalledWith('ENCRYPTED-BLOB', 'a'.repeat(64))

    // riconciliazione: source config parsata, runId/tenant propagati
    expect(reconcileBatch).toHaveBeenCalledOnce()
    const [batch, source, runId, tenantId] = reconcileBatch.mock.calls[0] as [DiscoveredCI[], SyncSourceConfig, string, string]
    expect(batch.map((c) => c.external_id)).toEqual(['ext-1', 'ext-2', 'ext-3'])
    expect(source).toMatchObject({ id: 'src-1', tenant_id: 't1', connector_type: 'mock', config: { region: 'eu-south-1' }, mapping_rules: [], enabled: true })
    expect([runId, tenantId]).toEqual(['run-1', 't1'])
    expect(markStale).toHaveBeenCalledWith('src-1', 't1', 'run-1', new Set(['ext-1', 'ext-2', 'ext-3']))
    expect(updateProgress).not.toHaveBeenCalled()     // sotto la soglia di batch

    // SyncRun: running → completed
    const runs = runWrites()
    expect(runs.map((w) => w.p['status'])).toEqual(['running', 'completed'])
    expect(runs[0]!.p).toMatchObject({ runId: 'run-1', tenantId: 't1', completedAt: null, errorMsg: null })
    expect(runs[1]!.q).toContain('MATCH (r:SyncRun {id: $runId, tenant_id: $tenantId})')
    expect(runs[1]!.p).toMatchObject({
      runId: 'run-1', tenantId: 't1', status: 'completed', errorMsg: null,
      ciCreated: 3, ciUpdated: 0, ciUnchanged: 0, ciStale: 2, ciConflicts: 0, relCreated: 0, relRemoved: 0,
    })
    expect(runs[1]!.p['durationMs']).toEqual(expect.any(Number))
    expect(runs[1]!.p['completedAt']).toEqual(expect.any(String))

    // SyncSource meta + evento
    expect(sourceWrites()).toHaveLength(1)
    expect(sourceWrites()[0]!.p).toMatchObject({ sourceId: 'src-1', tenantId: 't1', status: 'completed', durationMs: expect.any(Number) })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sync.completed', tenant_id: 't1', correlation_id: 'run-1', actor_id: 'system',
      payload: expect.objectContaining({ runId: 'run-1', sourceId: 'src-1', tenantId: 't1', stats: expect.objectContaining({ ciCreated: 3, ciStale: 2 }) }),
    }))
    expect(close).toHaveBeenCalled()
  })

  it('120 risorse → batch da 50 (50/50/20), progresso aggiornato dopo ogni batch pieno', async () => {
    getConnector.mockReturnValue(connectorYielding(Array.from({ length: 120 }, (_, i) => ci(i))))
    const { job, updateProgress } = makeJob()

    await processor(job)

    expect(reconcileBatch.mock.calls.map((c) => (c[0] as DiscoveredCI[]).length)).toEqual([50, 50, 20])
    expect(updateProgress).toHaveBeenCalledTimes(2)
    expect(runWrites().at(-1)!.p).toMatchObject({ status: 'completed', ciCreated: 120 })
  })

  it('zero risorse → nessun batch, stale calcolati sull\'insieme vuoto, run completed', async () => {
    getConnector.mockReturnValue(connectorYielding([]))
    await processor(makeJob().job)
    expect(reconcileBatch).not.toHaveBeenCalled()
    expect(markStale).toHaveBeenCalledWith('src-1', 't1', 'run-1', new Set())
    expect(runWrites().at(-1)!.p['status']).toBe('completed')
  })

  it('publish dell\'evento che fallisce → warn, la run resta completed (evento best-effort)', async () => {
    getConnector.mockReturnValue(connectorYielding([ci(1)]))
    publish.mockRejectedValue(new Error('redis down'))
    await expect(processor(makeJob().job)).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'sync.completed' }), expect.stringContaining('Failed to publish event'))
  })
})

// ── Failures ─────────────────────────────────────────────────────────────────

describe('processSyncJob — connettore che lancia', () => {
  it('run marcata failed con il messaggio d\'errore e le statistiche parziali, source failed, evento sync.failed, e la promise RIGETTA', async () => {
    const boom = new Error('AWS: RequestExpired')
    getConnector.mockReturnValue(connectorYielding([ci(1), ci(2)], { count: 1, error: boom }))

    await expect(processor(makeJob().job)).rejects.toBe(boom)

    const runs = runWrites()
    expect(runs.map((w) => w.p['status'])).toEqual(['running', 'failed'])
    expect(runs[1]!.p).toMatchObject({ runId: 'run-1', tenantId: 't1', status: 'failed', errorMsg: 'AWS: RequestExpired', ciCreated: 0 })
    expect(runs[1]!.p['completedAt']).toEqual(expect.any(String))
    expect(sourceWrites()[0]!.p).toMatchObject({ sourceId: 'src-1', tenantId: 't1', status: 'failed', durationMs: null })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sync.failed', tenant_id: 't1',
      payload: expect.objectContaining({ runId: 'run-1', error: 'AWS: RequestExpired' }),
    }))
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: boom, runId: 'run-1' }), '[sync] Scan error')
    expect(markStale).not.toHaveBeenCalled()
  })

  it('errore dopo un batch già riconciliato → le statistiche parziali sono scritte sulla run failed', async () => {
    getConnector.mockReturnValue(connectorYielding(Array.from({ length: 60 }, (_, i) => ci(i)), { count: 55, error: new Error('half way') }))
    await expect(processor(makeJob().job)).rejects.toThrow('half way')
    expect(reconcileBatch).toHaveBeenCalledTimes(1)
    expect(runWrites().at(-1)!.p).toMatchObject({ status: 'failed', ciCreated: 50, errorMsg: 'half way' })
  })

  it('reconcileBatch che lancia → stesso trattamento (failed + rethrow)', async () => {
    getConnector.mockReturnValue(connectorYielding([ci(1)]))
    reconcileBatch.mockRejectedValue(new Error('MERGE for CI ext-1 returned no row'))
    await expect(processor(makeJob().job)).rejects.toThrow(/MERGE for CI/)
    expect(runWrites().at(-1)!.p).toMatchObject({ status: 'failed', errorMsg: 'MERGE for CI ext-1 returned no row' })
  })

  it('markStale che lancia → failed + rethrow', async () => {
    getConnector.mockReturnValue(connectorYielding([ci(1)]))
    markStale.mockRejectedValue(new Error('stale query timeout'))
    await expect(processor(makeJob().job)).rejects.toThrow('stale query timeout')
    expect(runWrites().at(-1)!.p['status']).toBe('failed')
  })
})

describe('processSyncJob — errori di configurazione (permanenti: run failed, nessun retry)', () => {
  it('connettore non registrato → run failed con messaggio, nessun evento, il job completa senza retry', async () => {
    getConnector.mockReturnValue(undefined)
    await expect(processor(makeJob().job)).resolves.toBeUndefined()
    expect(runWrites()).toHaveLength(1)
    expect(runWrites()[0]!.p).toMatchObject({ status: 'failed', errorMsg: 'Connector "mock" not registered', tenantId: 't1' })
    expect(decryptCredentials).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('decifratura credenziali fallita → run failed con il motivo, loggato, nessuna scansione', async () => {
    getConnector.mockReturnValue(connectorYielding([ci(1)]))
    decryptCredentials.mockImplementation(() => { throw new Error('bad auth tag') })
    await expect(processor(makeJob().job)).resolves.toBeUndefined()
    expect(runWrites()[0]!.p).toMatchObject({ status: 'failed', errorMsg: 'Failed to decrypt credentials: Error: bad auth tag' })
    expect(reconcileBatch).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', sourceId: 'src-1' }), '[sync] Credential decryption failed')
  })

  it('DISCOVERY_ENCRYPTION_KEY assente → run failed con messaggio esplicito (nessuna chiave di default)', async () => {
    vi.stubEnv('DISCOVERY_ENCRYPTION_KEY', '')
    resetConfigCache()
    try {
      getConnector.mockReturnValue(connectorYielding([ci(1)]))
      await expect(processor(makeJob().job)).resolves.toBeUndefined()
      expect(runWrites()[0]!.p['errorMsg']).toMatch(/DISCOVERY_ENCRYPTION_KEY is not set/)
      expect(decryptCredentials).not.toHaveBeenCalled()
    } finally {
      vi.stubEnv('DISCOVERY_ENCRYPTION_KEY', 'a'.repeat(64))
      resetConfigCache()
    }
  })

  it('SyncSource non trovata nel tenant → rigetta; la SyncRun NON viene aggiornata (resta nello stato del resolver)', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'run-1' }).mockResolvedValue(null)
    await expect(processor(makeJob().job)).rejects.toThrow('SyncSource src-1 not found')
    expect(runWrites()).toHaveLength(0)
    // Due sessioni chiuse: quella del nodo dell'esecuzione (D-5) e quella della sorgente.
    expect(close).toHaveBeenCalledTimes(2)
  })
})

// ── Worker / scheduler ───────────────────────────────────────────────────────

describe('startSyncWorker / scheduleTenantSyncs', () => {
  it('un worker per tenant su discovery-sync, con concorrenza 2, che registra le sync pianificate del tenant', () => {
    expect(DISCOVERY_SYNC_QUEUE).toBe('discovery-sync')
    expect(poolOptions.get('discovery-sync')).toMatchObject({ concurrency: 2, schedule: scheduleTenantSyncs })
  })

  it('registra uno scheduler per ogni sorgente abilitata con cron DEL TENANT, nella sua coda, con un id deterministico per sorgente', async () => {
    readRows = [{ id: 'src-1', cron: '0 */6 * * *' }, { id: 'src-2', cron: '30 2 * * *' }]

    await scheduleTenantSyncs(null, 't1')

    // Solo le sorgenti del tenant: la lettura è scopata.
    expect(reads[0]!.q).toContain('MATCH (s:SyncSource {tenant_id: $tenantId})')
    expect(reads[0]!.p).toEqual({ tenantId: 't1' })
    // Tutto nella coda del tenant, nessun'altra.
    expect(getTenantQueue.mock.calls.every(([base, tenant]) => base === 'discovery-sync' && tenant === 't1')).toBe(true)
    /*
     * Revisione totale · D-6: prima di registrarlo si toglie il vecchio, così
     * un cron cambiato non ne lascia due. Con BullMQ 6 si toglie per ID —
     * quello dello scheduler — invece di scorrere l'elenco dei ripetibili
     * cercando una chiave composta.
     */
    expect(removeScheduler).toHaveBeenCalledTimes(2)
    expect(removeScheduler).toHaveBeenCalledWith('sync-scheduled-src-1')

    expect(upsertScheduler).toHaveBeenCalledTimes(2)
    expect(upsertScheduler).toHaveBeenCalledWith(
      'sync-scheduled-src-1',
      { pattern: '0 */6 * * *' },
      {
        name: 'sync',
        data: { runId: 'scheduled-src-1', sourceId: 'src-1', tenantId: 't1', syncType: 'scheduled' },
        opts: { removeOnComplete: 50, removeOnFail: 20 },
      },
    )
  })

  it('errore DB nel caricamento delle sync pianificate → propaga: il pool non segna il tenant come pianificato e riprova al giro dopo', async () => {
    readError = new Error('neo4j down')
    await expect(scheduleTenantSyncs(null, 't1')).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalled()
  })
})
