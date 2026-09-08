/**
 * Daily email digest tick (jobs/emailDigestWorker.ts):
 *  - the tick sends only to tenants whose LOCAL hour is 08:00 (tenant timezone);
 *  - idempotency marker `digest:<tenant>:<localDate>` claimed with SET NX on the
 *    shared Redis (in-memory Map here): a second tick on the same local day is skipped;
 *  - recipients: admin/operator with coalesce(notifications_enabled, true) = true;
 *  - a Redis/tenant failure is aggregated and the tick REJECTS (no silent skip).
 * Pure helpers (localHourAndDate, digestMarkerKey, resolveTenantTimezone) are
 * covered in schedulerHelpers.test.ts and not repeated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

// ── Redis in-memory (SET key val EX ttl NX) ──────────────────────────────────

class FakeRedis {
  store = new Map<string, string>()
  failNext: Error | null = null
  set = vi.fn(async (key: string, value: string, _ex: 'EX', _ttl: number, nx?: 'NX'): Promise<'OK' | null> => {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e }
    if (nx === 'NX' && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  })
}
const redis = new FakeRedis()

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const queueAdd = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/bullmq.js', () => ({
  getSharedRedis: () => redis,
  createWorker: vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => { processors.set(name, processor); return { name, opts } }),
  getQueue: vi.fn(() => ({ add: queueAdd })),
}))

// ── Neo4j: runQuery dispatches on the Cypher text ───────────────────────────

interface TenantRow { id: string; timezone: string | null }
let tenants: TenantRow[] = []
let recipients: Record<string, Array<{ email: string }>> = {}
const queries: Array<{ q: string; p: Record<string, unknown> }> = []
const close = vi.fn().mockResolvedValue(undefined)

const runQuery = vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => {
  queries.push({ q, p })
  if (q.includes('MATCH (t:Tenant)')) return tenants
  if (q.includes('slaBreaches'))       return [{ openInc: 3, resolvedToday: 1, ongoingChanges: 2, slaBreaches: 0 }]
  if (q.includes('ORDER BY i.created_at')) return [{ title: 'Disk full', status: 'new', created: 'x' }]
  if (q.includes('MATCH (u:User'))     return recipients[p['t'] as string] ?? []
  throw new Error(`unexpected query: ${q}`)
})
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQuery: (...a: unknown[]) => runQuery(...(a as [unknown, string, Record<string, unknown>])),
}))

const sendEmail = vi.fn()
vi.mock('@opengraphity/notifications', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }))

vi.mock('../../lib/workflowHelpers.js', () => ({
  getOpenStepNames: vi.fn(async (_s: unknown, _t: string, entityType: string) => entityType === 'incident' ? ['new', 'in_progress'] : ['planning']),
  getWorkflowSteps: vi.fn(async () => [{ name: 'resolved', isInitial: false, isTerminal: false, isOpen: false, category: 'resolved', stepOrder: 5 }]),
}))

const digestDaily = vi.fn(() => ({ subject: 'Digest giornaliero', html: '<p>x</p>', text: 'x' }))
vi.mock('../../lib/emailTemplates.js', () => ({ digestDaily: (...a: unknown[]) => digestDaily(...(a as [])) }))

const logError = vi.fn()
const logInfo = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: logInfo, warn: vi.fn(), error: logError, debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { processDigestTick, startEmailDigestWorker, EMAIL_DIGEST_QUEUE } = await import('../emailDigestWorker.js')

// 06:00Z → 08:00 Europe/Rome (CEST), 02:00 America/New_York, 15:00 Asia/Tokyo
const AT_ROME_8 = new Date('2026-09-08T06:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  redis.store.clear()
  redis.failNext = null
  queries.length = 0
  tenants = [{ id: 'rome', timezone: 'Europe/Rome' }, { id: 'ny', timezone: 'America/New_York' }]
  recipients = { rome: [{ email: 'a@rome.io' }, { email: 'b@rome.io' }], ny: [{ email: 'c@ny.io' }] }
  sendEmail.mockResolvedValue(undefined)
})

describe('processDigestTick — fuso del tenant', () => {
  it('alle 06:00Z invia a Europe/Rome (08:00 locali) e salta America/New_York (02:00 locali)', async () => {
    const result = await processDigestTick(AT_ROME_8)

    expect(result).toEqual({ sent: ['rome'], skipped: ['ny'] })
    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(sendEmail.mock.calls.map((c) => (c[0] as { to: string }).to)).toEqual(['a@rome.io', 'b@rome.io'])
    expect(sendEmail).toHaveBeenCalledWith({ to: 'a@rome.io', subject: 'Digest giornaliero', html: '<p>x</p>', text: 'x' })
  })

  it('alle 12:00Z tocca a New_York (08:00 EDT): Roma (14:00) è saltata', async () => {
    const result = await processDigestTick(new Date('2026-09-08T12:00:00.000Z'))
    expect(result).toEqual({ sent: ['ny'], skipped: ['rome'] })
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'c@ny.io' }))
  })

  it('tenant senza timezone → UTC (08:00Z)', async () => {
    tenants = [{ id: 'utc-tenant', timezone: null }]
    recipients = { 'utc-tenant': [{ email: 'u@x.io' }] }
    await expect(processDigestTick(new Date('2026-09-08T08:30:00.000Z'))).resolves.toEqual({ sent: ['utc-tenant'], skipped: [] })
    await expect(processDigestTick(new Date('2026-09-09T06:30:00.000Z'))).resolves.toEqual({ sent: [], skipped: ['utc-tenant'] })
  })

  it('timezone non valida su un tenant → quel tenant fallisce, gli altri vengono serviti, poi il tick rigetta', async () => {
    tenants = [{ id: 'bad', timezone: 'Mars/Olympus' }, { id: 'rome', timezone: 'Europe/Rome' }]
    await expect(processDigestTick(AT_ROME_8)).rejects.toThrow('[email-digest] digest failed for 1 tenant(s) — see log')
    expect(sendEmail).toHaveBeenCalledTimes(2)         // rome servito
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'bad' }), 'Digest failed for tenant')
  })
})

describe('processDigestTick — marker di idempotenza (SET NX)', () => {
  it('reclama digest:<tenant>:<data locale> con EX 36h NX prima di inviare', async () => {
    await processDigestTick(AT_ROME_8)

    expect(redis.set).toHaveBeenCalledOnce()             // solo Roma è in finestra
    expect(redis.set).toHaveBeenCalledWith('digest:rome:2026-09-08', '2026-09-08T06:00:00.000Z', 'EX', 36 * 3600, 'NX')
    expect(redis.store.get('digest:rome:2026-09-08')).toBe('2026-09-08T06:00:00.000Z')
  })

  it('secondo tick nello stesso giorno locale → saltato, nessuna seconda email', async () => {
    await processDigestTick(AT_ROME_8)
    expect(sendEmail).toHaveBeenCalledTimes(2)

    const second = await processDigestTick(new Date('2026-09-08T06:20:00.000Z'))

    expect(second).toEqual({ sent: [], skipped: ['rome', 'ny'] })
    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'rome', date: '2026-09-08' }), expect.stringContaining('already sent'))
  })

  it('il giorno locale successivo il marker è diverso → invio di nuovo', async () => {
    await processDigestTick(AT_ROME_8)
    const next = await processDigestTick(new Date('2026-09-09T06:00:00.000Z'))
    expect(next.sent).toEqual(['rome'])
    expect(redis.store.has('digest:rome:2026-09-09')).toBe(true)
    expect(sendEmail).toHaveBeenCalledTimes(4)
  })

  it('il marker è reclamato PRIMA della lettura dei dati: Redis che fallisce → nessuna query dati, nessuna email, tick rigetta', async () => {
    redis.failNext = new Error('READONLY You can\'t write against a read only replica')
    await expect(processDigestTick(AT_ROME_8)).rejects.toThrow(/digest failed for 1 tenant/)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(queries.filter((x) => x.q.includes('MATCH (u:User'))).toHaveLength(0)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'rome', err: expect.any(Error) }), 'Digest failed for tenant')
    expect(redis.store.size).toBe(0)
  })
})

describe('processDigestTick — destinatari', () => {
  it('la Cypher filtra admin/operator con coalesce(notifications_enabled, true) = true, scopata per tenant', async () => {
    await processDigestTick(AT_ROME_8)

    const users = queries.filter((x) => x.q.includes('MATCH (u:User'))
    expect(users).toHaveLength(1)
    expect(users[0]!.p).toEqual({ t: 'rome' })
    expect(users[0]!.q).toContain('MATCH (u:User {tenant_id: $t})')
    expect(users[0]!.q).toMatch(/u\.role IN \['admin', 'operator', 'TENANT_ADMIN', 'OPERATOR'\]/)
    expect(users[0]!.q).toContain('coalesce(u.notifications_enabled, true) = true')
    expect(users[0]!.q).toMatch(/u\.email IS NOT NULL AND u\.email <> ''/)
  })

  it('le query di statistiche sono tutte scopate per tenant ($t)', async () => {
    await processDigestTick(AT_ROME_8)
    for (const { q, p } of queries.filter((x) => !x.q.includes('MATCH (t:Tenant)'))) {
      expect(q).toContain('tenant_id: $t')
      expect(p['t']).toBe('rome')
    }
  })

  it('nessun destinatario → tenant "sent" (marker reclamato), nessuna email, nessun errore', async () => {
    recipients = { rome: [] }
    await expect(processDigestTick(AT_ROME_8)).resolves.toEqual({ sent: ['rome'], skipped: ['ny'] })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(digestDaily).not.toHaveBeenCalled()
  })

  it('il template riceve le statistiche numeriche e gli eventi recenti del tenant', async () => {
    await processDigestTick(AT_ROME_8)
    expect(digestDaily).toHaveBeenCalledWith(
      { openIncidents: 3, resolvedToday: 1, ongoingChanges: 2, slaBreaches: 0, recentEvents: ['Disk full (new)'] },
      'rome',
    )
  })

  it('un invio fallito su N → gli altri partono, poi il tick rigetta con il conteggio', async () => {
    sendEmail.mockRejectedValueOnce(new Error('smtp 550'))
    await expect(processDigestTick(AT_ROME_8)).rejects.toThrow(/digest failed for 1 tenant/)
    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@rome.io', tenantId: 'rome' }), 'Failed to send digest email')
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'rome', err: expect.objectContaining({ message: '[email-digest] 1/2 digest emails failed for tenant rome' }) }),
      'Digest failed for tenant',
    )
  })

  it('sessioni Neo4j chiuse anche in caso di errore', async () => {
    sendEmail.mockRejectedValue(new Error('down'))
    await processDigestTick(AT_ROME_8).catch(() => undefined)
    expect(close).toHaveBeenCalled()
  })
})

describe('startEmailDigestWorker', () => {
  it('registra il tick orario (UTC) con jobId fisso e un worker a concorrenza 1', async () => {
    await startEmailDigestWorker()
    expect(queueAdd).toHaveBeenCalledWith('digest-tick', {}, {
      repeat: { pattern: '0 * * * *', tz: 'UTC' }, jobId: 'email-digest-tick', removeOnComplete: true,
    })
    expect(processors.has(EMAIL_DIGEST_QUEUE)).toBe(true)
  })

  it('registrazione del repeatable che fallisce → errore di startup propagato', async () => {
    queueAdd.mockRejectedValueOnce(new Error('redis down'))
    await expect(startEmailDigestWorker()).rejects.toThrow('redis down')
  })

  it('il processor esegue un tick con l\'ora corrente', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(AT_ROME_8)
      await startEmailDigestWorker()
      await processors.get(EMAIL_DIGEST_QUEUE)!({ name: 'digest-tick', data: {} } as unknown as Job)
      expect(sendEmail).toHaveBeenCalledTimes(2)
      expect(redis.store.has('digest:rome:2026-09-08')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
