/**
 * Daily email digest — the failure and fallback paths the main suite skips.
 *
 *  - When the send fails AND the idempotency marker cannot be removed, the
 *    tenant gets no digest today: that must be logged as such (an operator
 *    must be able to tell "sent" from "lost"), and the tick must still fail.
 *  - "Resolved today" must count incidents in the terminal steps when the
 *    workflow has no step of category `resolved`, not silently count zero.
 *  - A rule target that cannot address a digest (not `all`, not `role:x`) is
 *    an error for that tenant, not a digest sent to everybody.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redis = {
  set: vi.fn(async (): Promise<'OK' | null> => 'OK'),
  del: vi.fn(async (): Promise<number> => 1),
}
vi.mock('../../lib/bullmq.js', () => ({
  getSharedRedis: () => redis,
  createTenantWorkers: vi.fn(),
}))

let tenants: Array<Record<string, unknown>> = []
let stats: Array<Record<string, unknown>> = []
const queries: Array<{ q: string; p: Record<string, unknown> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  runQuery: vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => {
    queries.push({ q, p })
    if (q.includes('MATCH (t:Tenant {id: $tenantId})')) return tenants
    if (q.includes('slaBreaches')) return stats
    if (q.includes('ORDER BY i.created_at')) return []
    if (q.includes('MATCH (u:User')) return [{ email: 'a@rome.io' }]
    throw new Error(`unexpected query: ${q}`)
  }),
}))

const sendEmail = vi.fn()
vi.mock('@opengraphity/notifications', () => ({
  sendTenantEmail: (_t: string, ...a: unknown[]) => sendEmail(...a),
  loadTenantBrand: async () => ({ displayName: 'ACME' }),
  loadNotificationLocale: async () => ({ language: 'en', timeZone: 'UTC' }),
}))

const getWorkflowSteps = vi.fn()
vi.mock('../../lib/workflowHelpers.js', () => ({
  getOpenStepNames: vi.fn(async () => ['new']),
  getWorkflowSteps: (...a: unknown[]) => getWorkflowSteps(...a),
}))

const digestDaily = vi.fn((..._a: unknown[]) => ({ subject: 's', html: 'h', text: 't' }))
vi.mock('../../lib/emailTemplates.js', () => ({ digestDaily: (...a: unknown[]) => digestDaily(...a) }))

const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => logError(...a), debug: vi.fn() }) },
}))

const { processDigestTick, digestRole, digestDue } = await import('../emailDigestWorker.js')

// 06:00Z → 08:00 in Europe/Rome (CEST)
const AT_ROME_8 = new Date('2026-09-08T06:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  queries.length = 0
  tenants = [{ id: 'rome', timezone: 'Europe/Rome', digestTime: '08:00', target: 'all', recipients: null }]
  stats = [{ openInc: 1, resolvedToday: 0, ongoingChanges: 0, slaBreaches: 0 }]
  sendEmail.mockResolvedValue(undefined)
  getWorkflowSteps.mockResolvedValue([{ name: 'resolved', category: 'resolved', isTerminal: false }])
})

describe('marker removal that fails after a failed send', () => {
  it('logs that today\'s digest is lost for the tenant, and the tick still rejects', async () => {
    sendEmail.mockRejectedValue(new Error('smtp down'))
    redis.del.mockRejectedValueOnce(new Error('redis gone'))
    await expect(processDigestTick('t1', AT_ROME_8)).rejects.toThrow(/digest failed for 1 tenant/)
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'rome', date: '2026-09-08', err: expect.objectContaining({ message: 'redis gone' }) }),
      expect.stringContaining('marker could not be removed'),
    )
  })
})

describe('"resolved today" step names', () => {
  it('without a step of category resolved, the terminal steps are counted', async () => {
    getWorkflowSteps.mockResolvedValue([
      { name: 'new', category: 'open', isTerminal: false },
      { name: 'closed', category: 'closed', isTerminal: true },
      { name: 'cancelled', category: 'closed', isTerminal: true },
    ])
    await processDigestTick('t1', AT_ROME_8)
    const q = queries.find((x) => x.q.includes('slaBreaches'))!
    expect(q.p['resolvedStepNames']).toEqual(['closed', 'cancelled'])
  })

  it('every resolved-category step is counted, not only the first', async () => {
    getWorkflowSteps.mockResolvedValue([
      { name: 'resolved', category: 'resolved', isTerminal: false },
      { name: 'fixed', category: 'resolved', isTerminal: false },
      { name: 'closed', category: 'closed', isTerminal: true },
    ])
    await processDigestTick('t1', AT_ROME_8)
    expect(queries.find((x) => x.q.includes('slaBreaches'))!.p['resolvedStepNames']).toEqual(['resolved', 'fixed'])
  })

  it('no stats row → the digest reports zeros rather than NaN', async () => {
    stats = []
    await processDigestTick('t1', AT_ROME_8)
    expect(digestDaily.mock.calls[0]![0]).toMatchObject({ openIncidents: 0, resolvedToday: 0, ongoingChanges: 0, slaBreaches: 0 })
  })
})

describe('rule target', () => {
  it('digestRole: all/null → people who work tickets, role:x → x', () => {
    expect(digestRole(null)).toBeNull()
    expect(digestRole('all')).toBeNull()
    expect(digestRole('role:manager')).toBe('manager')
  })

  it('digestRole: any other target is refused with the offending value', () => {
    expect(() => digestRole('team:network')).toThrow('digest.daily rule target "team:network" cannot address a tenant digest')
  })

  it('a tenant with an unusable target gets no email and the tick fails visibly', async () => {
    tenants = [{ id: 'rome', timezone: 'Europe/Rome', digestTime: '08:00', target: 'group:x', recipients: null }]
    await expect(processDigestTick('t1', AT_ROME_8)).rejects.toThrow(/digest failed for 1 tenant/)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a rule without digest_time is an error for that tenant, not a digest at a guessed hour', async () => {
    tenants = [{ id: 'rome', timezone: 'Europe/Rome', digestTime: null, target: 'all', recipients: null }]
    await expect(processDigestTick('t1', AT_ROME_8)).rejects.toThrow(/digest failed for 1 tenant/)
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'rome', err: expect.objectContaining({ message: expect.stringContaining('has no digest_time') }) }),
      'Digest failed for tenant',
    )
  })
})

describe('digest_time on the rule', () => {
  it('a malformed time fails that tenant with the offending value, instead of never or always sending', async () => {
    expect(() => digestDue({ hour: 8, minute: 0 }, '8:00')).toThrow('invalid digest_time "8:00" (expected HH:MM)')
    tenants = [{ id: 'rome', timezone: 'Europe/Rome', digestTime: '8am', target: 'all', recipients: null }]
    await expect(processDigestTick('t1', AT_ROME_8)).rejects.toThrow(/digest failed for 1 tenant/)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
