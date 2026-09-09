/**
 * Maintenance worker (workers/maintenance.worker.ts): the daily backup job
 * invokes the shared runBackup({outputDir: BACKUP_DIR, …}) runner, VERIFIES
 * the archive (verify-backup) — a failed verification renames it to
 * `.invalid`, fails the job and counts a metric — then prunes to the last
 * BACKUP_RETENTION archives (default 14; `.partial`/`.invalid` rotate too).
 * Rotation runs even after a failed backup. The repeatable jobs are
 * re-registered at startup (stale copies removed first). Ondata 4: the daily
 * `purge_events` job (03:30) delegates to services/eventRetention.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'
import { resetConfigCache } from '../../lib/config.js'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const createWorker = vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => { processors.set(name, processor); return { name, opts } })
const queue = {
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
}
vi.mock('../../lib/bullmq.js', () => ({
  createWorker: (...a: unknown[]) => createWorker(...(a as [string, AnyProcessor, unknown])),
  getQueue: vi.fn(() => queue),
}))

const runBackup = vi.fn()
vi.mock('../../scripts/backup-neo4j.js', () => ({ runBackup: (opts: unknown) => runBackup(opts) }))
const verifyBackup = vi.fn()
vi.mock('../../scripts/verify-backup.js', () => ({
  verifyBackup: (p: string) => verifyBackup(p),
  formatReport: () => 'report',
}))

const metricInc = vi.fn()
const gaugeSet  = vi.fn()
vi.mock('../../middleware/metrics.js', () => ({
  backupRunsTotal:            { inc: (...a: unknown[]) => metricInc(...a) },
  backupLastSuccessTimestamp: { set: (...a: unknown[]) => gaugeSet(...a) },
}))
const purgeResolvedEvents = vi.fn()
vi.mock('../../services/eventRetention.js', () => ({ purgeResolvedEvents: (...a: unknown[]) => purgeResolvedEvents(...a) }))

const readdirSync = vi.fn()
const statSync = vi.fn()
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readdirSync: (...a: unknown[]) => readdirSync(...a),
  statSync:    (...a: unknown[]) => statSync(...a),
}))
const unlink = vi.fn().mockResolvedValue(undefined)
const rename = vi.fn().mockResolvedValue(undefined)
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  unlink: (...a: unknown[]) => unlink(...a),
  rename: (...a: unknown[]) => rename(...a),
}))

const logWarn  = vi.fn()
const logInfo  = vi.fn()
const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: logInfo, warn: logWarn, error: logError, debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// BACKUP_DIR is read at import time (config.backupDir → path.resolve)
vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('BACKUP_DIR', '/var/backups/opengraphity')
vi.stubEnv('ATTACHMENT_DIR', '/var/lib/opengraphity/attachments')
vi.stubEnv('BACKUP_SKIP_KEYCLOAK', 'true')
resetConfigCache()

const { startMaintenanceWorker, MAINTENANCE_QUEUE, readBackupRetention, REPEATABLE_JOBS } = await import('../maintenance.worker.js')

const BACKUP_DIR = '/var/backups/opengraphity'
const ARCHIVE    = `${BACKUP_DIR}/backup_new.tar.gz`
const job = (name: string): Job => ({ name, data: {}, id: 'j-1' } as unknown as Job)
const enoent = () => Object.assign(new Error('no such dir'), { code: 'ENOENT' })

/** N archives named backup_<i>.tar.gz whose mtime grows with i (oldest first). */
function archives(n: number, extra: string[] = []) {
  readdirSync.mockReturnValue([...Array.from({ length: n }, (_, i) => `backup_${i}.tar.gz`), ...extra])
  statSync.mockImplementation((p: string) => ({ mtimeMs: Number(/backup_(\d+)\.tar\.gz/.exec(p)?.[1] ?? 0) * 1000 }))
}

let processor: AnyProcessor

beforeEach(async () => {
  vi.clearAllMocks()
  queue.getRepeatableJobs.mockResolvedValue([])
  runBackup.mockResolvedValue({ archivePath: ARCHIVE, nodeCount: 10, relCount: 4, durationMs: 42 })
  verifyBackup.mockResolvedValue({ archivePath: ARCHIVE, ok: true, problems: [], warnings: [], nodes: 10, rels: 4, restorableRels: 4, manifest: null })
  readdirSync.mockReturnValue([])
  await startMaintenanceWorker()
  processor = processors.get(MAINTENANCE_QUEUE)!
  vi.clearAllMocks()
})

describe('readBackupRetention', () => {
  it('default 14; integer >= 1 accepted; anything else is a config error', () => {
    expect(readBackupRetention({})).toBe(14)
    expect(readBackupRetention({ BACKUP_RETENTION: '' })).toBe(14)
    expect(readBackupRetention({ BACKUP_RETENTION: '30' })).toBe(30)
    expect(() => readBackupRetention({ BACKUP_RETENTION: '0' })).toThrow(/BACKUP_RETENTION/)
    expect(() => readBackupRetention({ BACKUP_RETENTION: 'many' })).toThrow(/BACKUP_RETENTION/)
  })
})

describe('startMaintenanceWorker', () => {
  it('rimuove i repeatable backup_database esistenti e ri-registra il job giornaliero a mezzanotte', async () => {
    queue.getRepeatableJobs.mockResolvedValue([
      { name: 'backup_database', key: 'stale-key-1' },
      { name: 'other_job',       key: 'other-key' },
    ])

    await startMaintenanceWorker()

    expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(1)
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key-1')
    expect(queue.add).toHaveBeenCalledWith('backup_database', {}, { repeat: { pattern: '0 0 * * *' } })
    expect(createWorker).toHaveBeenCalledWith(MAINTENANCE_QUEUE, expect.any(Function), { concurrency: 1 })
    expect(logInfo).toHaveBeenCalledWith({ backupDir: BACKUP_DIR, retention: 14 }, 'Maintenance worker started')
  })

  it('ondata 4: registra anche purge_events alle 03:30 e rimuove le sue copie stantie', async () => {
    queue.getRepeatableJobs.mockResolvedValue([{ name: 'purge_events', key: 'stale-purge' }, { name: 'backup_database', key: 'stale-backup' }])
    await startMaintenanceWorker()
    expect(REPEATABLE_JOBS.map((j) => [j.name, j.pattern])).toEqual([['backup_database', '0 0 * * *'], ['purge_events', '30 3 * * *']])
    expect(queue.removeRepeatableByKey.mock.calls.map((c) => c[0]).sort()).toEqual(['stale-backup', 'stale-purge'])
    expect(queue.add).toHaveBeenCalledWith('purge_events', {}, { repeat: { pattern: '30 3 * * *' } })
    expect(queue.add).toHaveBeenCalledTimes(2)
  })

  it('registrazione del repeatable che fallisce → errore di startup, nessun worker creato', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis down'))
    await expect(startMaintenanceWorker()).rejects.toThrow('redis down')
    expect(createWorker).not.toHaveBeenCalled()
  })
})

describe('job backup_database', () => {
  it('invoca runBackup con BACKUP_DIR/ATTACHMENT_DIR (Keycloak saltato per env), verifica, logga e conta ok', async () => {
    await expect(processor(job('backup_database'))).resolves.toBeUndefined()
    expect(runBackup).toHaveBeenCalledOnce()
    expect(runBackup).toHaveBeenCalledWith(expect.objectContaining({
      outputDir: BACKUP_DIR, attachmentDir: '/var/lib/opengraphity/attachments', skipKeycloak: true, keycloak: undefined,
    }))
    expect(verifyBackup).toHaveBeenCalledWith(ARCHIVE)
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ nodeCount: 10, relCount: 4 }), 'Backup completed')
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ archivePath: ARCHIVE }), 'Backup verified')
    expect(metricInc).toHaveBeenCalledWith({ result: 'ok' })
    expect(gaugeSet).toHaveBeenCalledWith({}, expect.any(Number))
    expect(rename).not.toHaveBeenCalled()
  })

  it('verifica fallita → archivio rinominato .invalid, logger.error con i problemi, metrica verify_failed, job fallito; la retention gira comunque', async () => {
    verifyBackup.mockResolvedValue({ archivePath: ARCHIVE, ok: false, problems: ['nodes.jsonl: 9 righe, manifest node_count 10'], warnings: [], nodes: 9, rels: 4, restorableRels: 4, manifest: null })
    archives(3)

    await expect(processor(job('backup_database'))).rejects.toThrow(/Backup verification failed/)
    expect(rename).toHaveBeenCalledWith(ARCHIVE, `${ARCHIVE}.invalid`)
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ archivePath: `${ARCHIVE}.invalid`, problems: ['nodes.jsonl: 9 righe, manifest node_count 10'] }),
      expect.stringContaining('verification FAILED'),
    )
    expect(metricInc).toHaveBeenCalledWith({ result: 'verify_failed' })
    expect(gaugeSet).not.toHaveBeenCalled()
    expect(readdirSync).toHaveBeenCalledWith(BACKUP_DIR)   // rotation still ran
  })

  it('retention: con 16 archivi cancella i 2 più vecchi (per mtime), includendo .partial/.invalid e ignorando i file non-archivio', async () => {
    archives(15, ['backup_0.tar.gz.partial', 'backup_nodes_x.jsonl', 'notes.txt', 'backup_zzz.tgz'])

    await processor(job('backup_database'))

    expect(readdirSync).toHaveBeenCalledWith(BACKUP_DIR)
    expect(unlink).toHaveBeenCalledTimes(2)
    // both backup_0.tar.gz and backup_0.tar.gz.partial have mtime 0 → the two oldest
    expect(unlink.mock.calls.map((c) => c[0]).sort()).toEqual([`${BACKUP_DIR}/backup_0.tar.gz`, `${BACKUP_DIR}/backup_0.tar.gz.partial`])
    expect(logInfo).toHaveBeenCalledWith({ retention: 14, deleted: 2 }, 'Old backups pruned')
  })

  it('con 14 o meno archivi non cancella nulla', async () => {
    archives(14)
    await processor(job('backup_database'))
    expect(unlink).not.toHaveBeenCalled()
  })

  it('directory di backup inesistente (ENOENT) → nulla da potare, il job completa', async () => {
    readdirSync.mockImplementation(() => { throw enoent() })
    await expect(processor(job('backup_database'))).resolves.toBeUndefined()
    expect(unlink).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith({ backupDir: BACKUP_DIR }, expect.stringContaining('nothing to prune'))
  })

  it('altro errore fs (EACCES) durante la retention → il job fallisce', async () => {
    readdirSync.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    await expect(processor(job('backup_database'))).rejects.toThrow('denied')
    expect(runBackup).toHaveBeenCalledOnce()     // il backup era già stato fatto
  })

  it('runner che fallisce → il job fallisce con metrica backup_failed, nessuna verifica; la retention gira comunque', async () => {
    runBackup.mockRejectedValue(new Error('tar: command not found'))
    await expect(processor(job('backup_database'))).rejects.toThrow('tar: command not found')
    expect(verifyBackup).not.toHaveBeenCalled()
    expect(metricInc).toHaveBeenCalledWith({ result: 'backup_failed' })
    expect(readdirSync).toHaveBeenCalledWith(BACKUP_DIR)
  })

  it('unlink che fallisce → il job fallisce', async () => {
    archives(15)
    unlink.mockRejectedValueOnce(new Error('EPERM'))
    await expect(processor(job('backup_database'))).rejects.toThrow('EPERM')
  })
})

describe('job purge_events (ondata 4)', () => {
  it('delega a purgeResolvedEvents e logga i conteggi per tenant; un errore (tenant senza policy) fa fallire il job', async () => {
    const result = { tenants: 2, purged: 12, failed: 0, perTenant: [{ tenantId: 'acme', retentionDays: 90, cutoff: 'C', purged: 12 }, { tenantId: 'globex', retentionDays: 0, cutoff: null, purged: 0 }] }
    purgeResolvedEvents.mockResolvedValue(result)
    await expect(processor(job('purge_events'))).resolves.toBeUndefined()
    expect(purgeResolvedEvents).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith({ tenants: 2, purged: 12, perTenant: result.perTenant }, 'Resolved events purged (retention)')
    expect(runBackup).not.toHaveBeenCalled()

    purgeResolvedEvents.mockRejectedValueOnce(new Error('purgeResolvedEvents: 1/2 tenants failed'))
    await expect(processor(job('purge_events'))).rejects.toThrow(/1\/2 tenants failed/)
  })
})

describe('job sconosciuto', () => {
  it('dovrebbe fallire esplicitamente — BUG: maintenance.worker.ts logga un warn e completa il job (fallback silenzioso)', async () => {
    await expect(processor(job('vacuum_everything'))).rejects.toThrow()
  })

})
