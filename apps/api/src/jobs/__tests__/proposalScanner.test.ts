/**
 * The proposal scan: analysts in, proposals out, one tenant at a time.
 * (The Redis lock itself is covered in proposalScanLock.test.ts.)
 *
 * Why these behaviours matter for a user:
 *  - one analyst crashing must not take the others' proposals with it: a
 *    broken model call would otherwise leave the proposals page empty;
 *  - every tenant has its own queue `proposal-scanner@<tenant>` and its own
 *    nightly job (23 Sep 2026): a failing tenant fails ITS run, visibly, and
 *    no other tenant is even read — a suspended one has its queues paused;
 *  - expiry and wake-up of the tenant's old proposals run BEFORE the analysis:
 *    without it a tenant with five ignored proposals never gets new ones,
 *    silently;
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
  workers: [] as Array<{ name: string; processor: unknown; opts: unknown }>,
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
  createTenantWorkers: (name: string, processor: unknown, opts: unknown) => { fake.workers.push({ name, processor, opts }); return { name } },
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
  scadiLeVecchie: async (t: string) => { fake.sweeps.push(`expire:${t}`); return fake.expired },
  risvegliaLeRimandate: async (t: string) => { fake.sweeps.push(`wake:${t}`); return fake.woken },
  purgaLeChiuse: async (t: string) => { fake.sweeps.push(`purge:${t}`); return 0 },
}))

const { logger } = await import('../../lib/logger.js')
const {
  analizzaCliente, proposalScannerProcessor, scheduleProposalScan, startProposalScanner, PROPOSAL_SCANNER_QUEUE,
} = await import('../proposalScanner.js')

const job = (tenantId: string) => ({ data: { tenantId } }) as unknown as Job<{ tenantId: string }>
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
  it('the nightly run of a tenant: its sweeps first, then its analysis — and no other tenant is read', async () => {
    fake.expired = 2
    fake.analysts = { config: async (t) => { fake.sweeps.push(`analyse:${t}`); return [] } }
    await proposalScannerProcessor(job('t-a'))
    expect(fake.sweeps).toEqual(['expire:t-a', 'wake:t-a', 'purge:t-a', 'analyse:t-a'])
    // The queue says which tenant: the list of tenants is not read any more.
    expect(fake.tenantQueries).toEqual([])
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-a', scadute: 2, risvegliate: 0 }), expect.any(String))
  })

  it('nothing swept: no sweep log line', async () => {
    await proposalScannerProcessor(job('t-a'))
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(expect.objectContaining({ scadute: 0 }), expect.any(String))
  })

  it('a tenant already being analysed is skipped, not analysed twice, and leaves no run entry', async () => {
    fake.lockHeld.add('proposal-scan-lock:t-a')
    const seen: string[] = []
    fake.analysts = { config: async (t) => { seen.push(t); return [] } }
    await proposalScannerProcessor(job('t-a'))
    expect(seen).toEqual([])
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith({ module: 'proposals', tenantId: 't-a' }, 'proposal-scanner: already running, skipped')
    // The run holding the lock writes its own entry.
    expect(fake.audits).toEqual([])
  })

  it('the run leaves the entry the page reads, as the product (tour of 23 Sep 2026)', async () => {
    fake.analysts = { config: async (t) => [proposal(t, 'x')] }
    await proposalScannerProcessor(job('t-a'))
    expect(fake.audits).toEqual([
      { ctx: expect.objectContaining({ tenantId: 't-a', userId: 'system' }), action: 'proposal.analysis_run', entityId: 't-a',
        details: { created: 1, skipped: {}, source: 'nightly' } },
    ])
  })

  it('nothing to propose is still a run: the page must not say «never ran»', async () => {
    await proposalScannerProcessor(job('t-b'))
    expect(fake.audits.map((a) => [a.entityId, a.details])).toEqual([['t-b', { created: 0, skipped: {}, source: 'nightly' }]])
  })

  it('a failing tenant fails its own run, visibly, and leaves no run entry', async () => {
    fake.analysts = { config: async (t) => [proposal(t, 'x')] }
    fake.writeResult = () => { throw new Error('neo4j down') }
    await expect(proposalScannerProcessor(job('t-a'))).rejects.toThrow('neo4j down')
    expect(fake.audits).toEqual([])
  })
})

describe('queue and nightly schedule', () => {
  it('one worker per tenant on the proposal-scanner queue, each with its tenant\'s nightly run, one run at a time in the process', () => {
    const pool = startProposalScanner()
    expect(pool).toEqual({ name: PROPOSAL_SCANNER_QUEUE })
    // Every tenant's run fires at 04:30: they take turns, as when one job went through the tenants in order.
    expect(fake.workers).toEqual([{ name: 'proposal-scanner', processor: proposalScannerProcessor, opts: { schedule: scheduleProposalScan, processLimit: 1 } }])
  })

  it('the nightly run of a tenant is one fixed-id scheduler at 04:30, carrying its tenant', async () => {
    const queue = { upsertJobScheduler: async (...args: unknown[]) => { fake.schedulers.push(args) } }
    await scheduleProposalScan(queue as never, 't-a')
    expect(fake.schedulers).toEqual([[
      'proposal-scanner-nightly',
      { pattern: '30 4 * * *' },
      { name: 'scan', data: { tenantId: 't-a' }, opts: { removeOnComplete: true } },
    ]])
  })
})
