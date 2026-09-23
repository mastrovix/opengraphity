/**
 * The proposal scan: analysts in, proposals out, one tenant at a time.
 * (The Redis lock itself is covered in proposalScanLock.test.ts.)
 *
 * Why these behaviours matter for a user:
 *  - one analyst crashing must not take the others' proposals with it: a
 *    broken model call would otherwise leave the proposals page empty;
 *  - one tenant failing must not stop the others, yet the run must still be
 *    reported as failed (naming the tenant) so an operator sees it;
 *  - expiry and wake-up of old proposals run BEFORE the analysis, and only in
 *    the nightly run: without it a tenant with five ignored proposals never
 *    gets new ones, silently;
 *  - suspended tenants and the `system` scope are never analysed (the query
 *    says so); a click on "Analyse now" analyses exactly that tenant;
 *  - a scan already running for a tenant is skipped, not doubled (tokens spent twice);
 *  - the nightly schedule is an upsert with a fixed id: restarting the worker
 *    must not create a second nightly run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const fake = vi.hoisted(() => ({
  tenants: ['t-a', 't-b'] as string[],
  tenantQueries: [] as string[],
  analysts: {} as Record<string, (tenantId: string) => Promise<unknown[]>>,
  written: [] as Array<Record<string, unknown>>,
  writeResult: (_p: Record<string, unknown>): { scritta: boolean; motivo?: string } => ({ scritta: true }),
  expired: 0,
  woken: 0,
  sweeps: [] as string[],
  lockHeld: new Set<string>(),
  schedulers: [] as unknown[][],
  workers: [] as Array<{ name: string; processor: unknown }>,
  audits: [] as Array<{ ctx: Record<string, unknown>; action: string; entityId: string; details: Record<string, unknown> }>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async <T>(fn: (tx: { run: (q: string) => Promise<unknown> }) => Promise<T>) => fn({
      run: async (q: string) => {
        fake.tenantQueries.push(q)
        return { records: fake.tenants.map((id) => ({ get: () => id })) }
      },
    }),
    close: async () => undefined,
  }),
}))
vi.mock('../../lib/bullmq.js', () => ({
  getSharedRedis: () => ({
    set: async (k: string) => (fake.lockHeld.has(k) ? null : 'OK'),
    get: async () => null,
    del: async () => 1,
  }),
  getQueue: (name: string) => ({
    name,
    upsertJobScheduler: async (...args: unknown[]) => { fake.schedulers.push(args) },
  }),
  createWorker: (name: string, processor: unknown) => { fake.workers.push({ name, processor }); return { name } },
}))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../lib/audit.js', () => ({
  audit: async (ctx: Record<string, unknown>, action: string, _type: string, entityId: string, details: Record<string, unknown>) => {
    fake.audits.push({ ctx, action, entityId, details })
  },
}))
vi.mock('../../lib/proposalAnalysts.js', () => ({
  analizzaConfigurazione: (t: string) => (fake.analysts['config'] ?? (async () => []))(t),
}))
vi.mock('../../lib/platformAnalyst.js', () => ({
  analizzaPiattaforma: (t: string) => (fake.analysts['platform'] ?? (async () => []))(t),
}))
vi.mock('../../lib/dailyWorkAnalyst.js', () => ({
  analizzaLavoroQuotidiano: (t: string) => (fake.analysts['daily'] ?? (async () => []))(t),
}))
vi.mock('../../lib/configurationAnalyst.js', () => ({
  analizzaConfigurazioneConIlModello: (t: string) => (fake.analysts['model'] ?? (async () => []))(t),
}))
vi.mock('../../lib/proposals.js', () => ({
  scriviProposta: async (p: Record<string, unknown>) => { fake.written.push(p); return fake.writeResult(p) },
  scadiLeVecchie: async () => { fake.sweeps.push('expire'); return fake.expired },
  risvegliaLeRimandate: async () => { fake.sweeps.push('wake'); return fake.woken },
}))

const { logger } = await import('../../lib/logger.js')
const {
  analizzaCliente, proposalScannerProcessor, getProposalScannerQueue, startProposalScanner, PROPOSAL_SCANNER_QUEUE,
} = await import('../proposalScanner.js')

const job = (data: { tenantId?: string } | undefined) => ({ data }) as unknown as Job<{ tenantId?: string }>
const proposal = (tenantId: string, kind: string) => ({ tenantId, kind })

beforeEach(() => {
  fake.tenants = ['t-a', 't-b']; fake.tenantQueries = []; fake.analysts = {}; fake.written = []
  fake.writeResult = () => ({ scritta: true }); fake.expired = 0; fake.woken = 0; fake.sweeps = []
  fake.lockHeld = new Set(); fake.schedulers = []; fake.workers = []; fake.audits = []
  vi.clearAllMocks()
})

describe('analizzaCliente', () => {
  it('collects proposals from every analyst and counts written and skipped by reason', async () => {
    fake.analysts = {
      config:   async (t) => [proposal(t, 'a'), proposal(t, 'b')],
      platform: async (t) => [proposal(t, 'c')],
      daily:    async (t) => [proposal(t, 'd')],
    }
    fake.writeResult = (p) => (p['kind'] === 'b' || p['kind'] === 'c'
      ? { scritta: false, motivo: 'gia_presente' }
      : p['kind'] === 'd' ? { scritta: false, motivo: 'tetto_aperte' } : { scritta: true })
    const out = await analizzaCliente('t-a')
    expect(out).toEqual({ create: 1, saltate: { gia_presente: 2, tetto_aperte: 1 } })
    expect(fake.written.map((p) => p['kind'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('an analyst that throws is logged and the others still write', async () => {
    fake.analysts = {
      config:   async () => { throw new Error('model timeout') },
      platform: async () => { throw 'not an error object' },
      model:    async (t) => [proposal(t, 'm')],
    }
    const out = await analizzaCliente('t-a')
    expect(out.create).toBe(1)
    expect(fake.written.map((p) => p['kind'])).toEqual(['m'])
    const errors = vi.mocked(logger.error).mock.calls.map((c) => (c[0] as { err: string }).err)
    expect(errors).toEqual(['model timeout', 'not an error object'])
  })
})

describe('proposalScannerProcessor', () => {
  it('nightly run: sweeps first, then analyses every active tenant', async () => {
    fake.expired = 2
    fake.analysts = { config: async (t) => { fake.sweeps.push(`analyse:${t}`); return [] } }
    await proposalScannerProcessor(job({}))
    expect(fake.sweeps).toEqual(['expire', 'wake', 'analyse:t-a', 'analyse:t-b'])
    // Suspended tenants and the system scope are excluded by the query itself.
    expect(fake.tenantQueries[0]).toContain("t.id <> 'system'")
    expect(fake.tenantQueries[0]).toContain("<> 'suspended'")
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.objectContaining({ scadute: 2, risvegliate: 0 }), expect.any(String))
  })

  it('a job without data is the nightly run too', async () => {
    fake.woken = 1
    await proposalScannerProcessor(job(undefined))
    expect(fake.sweeps).toEqual(['expire', 'wake'])
  })

  it('nothing swept: no sweep log line', async () => {
    fake.tenants = []
    await proposalScannerProcessor(job({}))
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(expect.objectContaining({ scadute: 0 }), expect.any(String))
  })

  it('an on-demand run analyses only the requested tenant and does not sweep', async () => {
    const seen: string[] = []
    fake.analysts = { config: async (t) => { seen.push(t); return [] } }
    await proposalScannerProcessor(job({ tenantId: 't-z' }))
    expect(seen).toEqual(['t-z'])
    expect(fake.sweeps).toEqual([])
    expect(fake.tenantQueries).toEqual([])
  })

  it('a tenant already being analysed is skipped, not analysed twice', async () => {
    fake.lockHeld.add('proposal-scan-lock:t-a')
    const seen: string[] = []
    fake.analysts = { config: async (t) => { seen.push(t); return [] } }
    await proposalScannerProcessor(job({}))
    expect(seen).toEqual(['t-b'])
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith({ module: 'proposals', tenantId: 't-a' }, 'proposal-scanner: already running, skipped')
    // Only the tenant analysed here gets a run entry: the other run writes its own.
    expect(fake.audits.map((a) => a.entityId)).toEqual(['t-b'])
  })

  it('every tenant analysed leaves the run entry the page reads, as the product (tour of 23 Sep 2026)', async () => {
    fake.analysts = { config: async (t) => (t === 't-a' ? [proposal(t, 'x')] : []) }
    await proposalScannerProcessor(job({}))
    expect(fake.audits).toEqual([
      { ctx: expect.objectContaining({ tenantId: 't-a', userId: 'system' }), action: 'proposal.analysis_run', entityId: 't-a',
        details: { created: 1, skipped: {}, source: 'nightly' } },
      // Nothing to propose is still a run: the page must not say «never ran».
      { ctx: expect.objectContaining({ tenantId: 't-b', userId: 'system' }), action: 'proposal.analysis_run', entityId: 't-b',
        details: { created: 0, skipped: {}, source: 'nightly' } },
    ])
  })

  it('a run asked for one tenant through the queue says so', async () => {
    await proposalScannerProcessor(job({ tenantId: 't-z' }))
    expect(fake.audits.map((a) => [a.entityId, a.details['source']])).toEqual([['t-z', 'queued']])
  })

  it('a failing tenant does not stop the others, and the run fails naming it', async () => {
    fake.tenants = ['t-a', 't-b', 't-c']
    fake.analysts = { config: async (t) => [proposal(t, 'x')] }
    fake.writeResult = (p) => {
      if (p['tenantId'] === 't-a') throw new Error('neo4j down')
      if (p['tenantId'] === 't-b') throw 'raw failure'
      return { scritta: true }
    }
    await expect(proposalScannerProcessor(job({}))).rejects.toThrow('proposal-scanner: 2 tenant(s) failed: t-a, t-b')
    // t-c still got its proposal written.
    expect(fake.written.some((p) => p['tenantId'] === 't-c')).toBe(true)
    // A tenant whose analysis failed has no run entry.
    expect(fake.audits.map((a) => a.entityId)).toEqual(['t-c'])
  })
})

describe('queue and nightly schedule', () => {
  it('the queue is the proposal-scanner queue', () => {
    expect((getProposalScannerQueue() as unknown as { name: string }).name).toBe(PROPOSAL_SCANNER_QUEUE)
  })

  it('starting the worker upserts one fixed-id nightly scheduler at 04:30 with an empty payload', async () => {
    const worker = await startProposalScanner()
    expect(worker).toEqual({ name: PROPOSAL_SCANNER_QUEUE })
    expect(fake.workers[0]?.processor).toBe(proposalScannerProcessor)
    expect(fake.schedulers).toEqual([[
      'proposal-scanner-nightly',
      { pattern: '30 4 * * *' },
      // Empty data = the nightly run over all tenants, with the lifecycle sweep.
      { name: 'scan', data: {}, opts: { removeOnComplete: true } },
    ]])
  })
})
