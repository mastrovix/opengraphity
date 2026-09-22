/**
 * Maintenance worker (workers/maintenance.worker.ts) — the jobs and switches
 * the sibling test does not reach.
 *
 * Why they matter:
 *  - BACKUP_SKIP_KEYCLOAK is validated at START: a typo ("yes") must stop the
 *    worker at boot, not make the midnight backup fail — or worse, silently
 *    skip the realm export that restores everyone's logins;
 *  - without the skip, the backup exports the Keycloak realm with the admin
 *    credentials read at backup time (trailing slash stripped from the URL);
 *  - the log-retention setting is also validated at start;
 *  - form drafts older than a day are purged, and files that could not be
 *    deleted from disk are reported (the space does not come back and no one
 *    else will pass there);
 *  - the server/browser log registries are pruned, and error signatures turn
 *    into monitoring events every quarter hour — logged only when something
 *    was actually raised, so a quiet system does not fill the log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Job } from 'bullmq'
import { resetConfigCache } from '../../lib/config.js'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const createWorker = vi.fn((name: string, processor: AnyProcessor) => { processors.set(name, processor); return { name } })
const queue = {
  upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  removeJobScheduler: vi.fn().mockResolvedValue(true),
}
vi.mock('../../lib/bullmq.js', () => ({
  createWorker: (...a: unknown[]) => createWorker(...(a as [string, AnyProcessor])),
  getQueue: vi.fn(() => queue),
}))

const runBackup = vi.fn()
vi.mock('../../scripts/backup-neo4j.js', () => ({ runBackup: (opts: unknown) => runBackup(opts) }))
vi.mock('../../scripts/verify-backup.js', () => ({
  verifyBackup: vi.fn(async (p: string) => ({ archivePath: p, ok: true, problems: [], warnings: [] })),
  formatReport: () => 'report',
}))
vi.mock('../../middleware/metrics.js', () => ({
  backupRunsTotal: { inc: vi.fn() },
  backupLastSuccessTimestamp: { set: vi.fn() },
}))
vi.mock('../../services/eventRetention.js', () => ({ purgeResolvedEvents: vi.fn() }))
vi.mock('@opengraphity/notifications', () => ({ pruneInbox: vi.fn() }))
vi.mock('../../lib/tenantInAppRetention.js', () => ({ inAppRetentionByTenant: vi.fn(async () => []) }))

const readdirSync = vi.fn((..._a: unknown[]) => [] as string[])
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readdirSync: (...a: unknown[]) => readdirSync(...a),
}))

const purgaIRegistriDeiLog = vi.fn()
const leggiGiorniDiRetention = vi.fn(() => 30)
vi.mock('../../services/serverLogRetention.js', () => ({
  purgaIRegistriDeiLog: () => purgaIRegistriDeiLog(),
  leggiGiorniDiRetention: () => leggiGiorniDiRetention(),
}))
const immettiEventiDaiLog = vi.fn()
vi.mock('../../lib/serverLogEvents.js', () => ({ immettiEventiDaiLog: () => immettiEventiDaiLog() }))
const purgeFormDrafts = vi.fn()
vi.mock('../../lib/formDraftPurge.js', () => ({ purgeFormDrafts: (before: string) => purgeFormDrafts(before) }))

const logInfo = vi.fn()
const logWarn = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: logInfo, warn: logWarn, error: vi.fn(), debug: vi.fn() }) },
}))

vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('BACKUP_DIR', '/var/backups/og')
vi.stubEnv('ATTACHMENT_DIR', '/var/lib/og/attachments')
vi.stubEnv('BACKUP_SKIP_KEYCLOAK', 'true')
resetConfigCache()

const { startMaintenanceWorker, MAINTENANCE_QUEUE, FORM_DRAFT_MAX_AGE_HOURS } = await import('../maintenance.worker.js')

const job = (name: string): Job => ({ name, data: {}, id: 'j-1' } as unknown as Job)
let processor: AnyProcessor

beforeEach(async () => {
  vi.stubEnv('BACKUP_SKIP_KEYCLOAK', 'true')
  await startMaintenanceWorker()
  processor = processors.get(MAINTENANCE_QUEUE)!
  vi.clearAllMocks()
  runBackup.mockResolvedValue({ archivePath: '/var/backups/og/backup_1.tar.gz', nodeCount: 1, relCount: 0, durationMs: 1 })
})
afterEach(() => {
  vi.stubEnv('BACKUP_SKIP_KEYCLOAK', 'true')
  resetConfigCache()
})

describe('startup validation', () => {
  it('BACKUP_SKIP_KEYCLOAK other than "true"/"false" stops the worker at boot', async () => {
    vi.stubEnv('BACKUP_SKIP_KEYCLOAK', 'yes')
    await expect(startMaintenanceWorker()).rejects.toThrow(/BACKUP_SKIP_KEYCLOAK must be "true" or "false" \(got "yes"\)/)
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('a malformed log retention stops the worker at boot, before anything is scheduled', async () => {
    leggiGiorniDiRetention.mockImplementationOnce(() => { throw new Error('SERVER_LOG_RETENTION_DAYS must be an integer') })
    await expect(startMaintenanceWorker()).rejects.toThrow(/SERVER_LOG_RETENTION_DAYS/)
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
  })
})

describe('backup_database with the Keycloak export', () => {
  it.each(['false', ''])('BACKUP_SKIP_KEYCLOAK=%j → the realm is exported with the admin credentials', async (value) => {
    vi.stubEnv('BACKUP_SKIP_KEYCLOAK', value)
    vi.stubEnv('KEYCLOAK_URL', 'http://kc.internal:8080//')
    vi.stubEnv('KEYCLOAK_ADMIN_USER', 'kc-admin')
    vi.stubEnv('KEYCLOAK_ADMIN_PASSWORD', 'not-a-real-password')
    resetConfigCache()

    await processor(job('backup_database'))

    expect(runBackup).toHaveBeenCalledWith(expect.objectContaining({
      skipKeycloak: false,
      // Trailing slashes are stripped: the runner appends /admin/realms/…
      keycloak: { baseUrl: 'http://kc.internal:8080', adminUser: 'kc-admin', adminPassword: 'not-a-real-password' },
    }))
  })

  it('a missing admin password fails THIS backup (not the worker start) and rotation still runs', async () => {
    vi.stubEnv('BACKUP_SKIP_KEYCLOAK', 'false')
    vi.stubEnv('KEYCLOAK_ADMIN_PASSWORD', '')
    resetConfigCache()
    await expect(processor(job('backup_database'))).rejects.toThrow(/KEYCLOAK_ADMIN_PASSWORD/)
    expect(runBackup).not.toHaveBeenCalled()
    expect(readdirSync).toHaveBeenCalled()
  })
})

describe('purge_form_drafts', () => {
  it('purges drafts older than a day and logs what went', async () => {
    purgeFormDrafts.mockResolvedValue({ nodes: 3, files: 2, filesFailed: 0 })
    const before = Date.now()
    await processor(job('purge_form_drafts'))
    const cutoff = Date.parse(purgeFormDrafts.mock.calls[0]![0] as string)
    expect(before - cutoff).toBeGreaterThanOrEqual(FORM_DRAFT_MAX_AGE_HOURS * 3_600_000 - 1000)
    expect(before - cutoff).toBeLessThan(FORM_DRAFT_MAX_AGE_HOURS * 3_600_000 + 1000)
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ nodes: 3 }), 'Unclaimed form draft attachments purged')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('nothing to purge → silent', async () => {
    purgeFormDrafts.mockResolvedValue({ nodes: 0, files: 0, filesFailed: 0 })
    await processor(job('purge_form_drafts'))
    expect(logInfo).not.toHaveBeenCalledWith(expect.anything(), 'Unclaimed form draft attachments purged')
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('files that could not be deleted from disk are reported as a warning', async () => {
    purgeFormDrafts.mockResolvedValue({ nodes: 0, files: 0, filesFailed: 2 })
    await processor(job('purge_form_drafts'))
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ filesFailed: 2 }), 'Unclaimed form draft attachments purged')
    expect(logWarn).toHaveBeenCalledWith({ filesFailed: 2 }, expect.stringContaining('could not be deleted'))
  })
})

describe('log registries', () => {
  it('purge_server_logs prunes both registries and logs the counts with the retention used', async () => {
    purgaIRegistriDeiLog.mockResolvedValue({ server: 120, browser: 4000, giorni: 30 })
    await processor(job('purge_server_logs'))
    expect(purgaIRegistriDeiLog).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith({ server: 120, browser: 4000, retentionDays: 30 }, 'Server and browser log registries pruned')
  })

  it('server_logs_to_events logs only when events were actually raised', async () => {
    immettiEventiDaiLog.mockResolvedValueOnce({ immessi: 0, esaminate: 12 })
    await processor(job('server_logs_to_events'))
    expect(logInfo).not.toHaveBeenCalledWith(expect.anything(), 'Server log signatures turned into monitoring events')

    immettiEventiDaiLog.mockResolvedValueOnce({ immessi: 2, esaminate: 12 })
    await processor(job('server_logs_to_events'))
    expect(logInfo).toHaveBeenCalledWith({ immessi: 2, esaminate: 12 }, 'Server log signatures turned into monitoring events')
  })

  it('a failure raising events fails the job (BullMQ retries it)', async () => {
    immettiEventiDaiLog.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(processor(job('server_logs_to_events'))).rejects.toThrow('neo4j down')
  })
})
