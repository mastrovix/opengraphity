import type { Worker, Job } from 'bullmq'
import { readdirSync, statSync }  from 'node:fs'
import { resolve }                from 'node:path'
import { rename, unlink }         from 'node:fs/promises'
import { runBackup }              from '../scripts/backup-neo4j.js'
import { verifyBackup, formatReport } from '../scripts/verify-backup.js'
import { logger }                 from '../lib/logger.js'
import { config }                 from '../lib/config.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { backupRunsTotal, backupLastSuccessTimestamp } from '../middleware/metrics.js'
import { purgeResolvedEvents } from '../services/eventRetention.js'

const maintenanceLogger = logger.child({ module: 'maintenance' })

const BACKUP_DIR = config.backupDir   // absolute; required in production

/**
 * Number of archives kept by the rotation (BACKUP_RETENTION, default 14 =
 * two weeks of nightly backups). Read from the environment until config.ts
 * grows a `backupRetention` reader (owned by another change); a non-integer
 * or < 1 value is a config error, not a silent default.
 */
export function readBackupRetention(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env['BACKUP_RETENTION']
  if (raw === undefined || raw === '') return 14
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`Environment variable BACKUP_RETENTION must be an integer >= 1 (got "${raw}")`)
  return n
}

/** BACKUP_SKIP_KEYCLOAK=true skips the realm export knowingly (a deployment without Keycloak admin access). */
function readSkipKeycloak(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env['BACKUP_SKIP_KEYCLOAK']
  if (raw === undefined || raw === '' || raw === 'false') return false
  if (raw === 'true') return true
  throw new Error(`Environment variable BACKUP_SKIP_KEYCLOAK must be "true" or "false" (got "${raw}")`)
}

export const MAINTENANCE_QUEUE = 'maintenance'

/** Job ripetibili della coda: nome → cron. Ri-registrati a ogni avvio (le copie stantie vengono rimosse prima). */
export const REPEATABLE_JOBS: ReadonlyArray<{ name: string; pattern: string; description: string }> = [
  { name: 'backup_database', pattern: '0 0 * * *',  description: 'daily at midnight' },
  // Event Management (ondata 4): eventi risolti oltre retention_days della policy del tenant.
  { name: 'purge_events',    pattern: '30 3 * * *', description: 'daily at 03:30' },
]

// ── Retention: keep last N archives ──────────────────────────────────────────
// `.partial` (unpublished) and `.invalid` (failed verification) archives are
// rotated with the same rule: kept for forensics, never forever.

const ARCHIVE_RE = /^backup_.*\.tar\.gz(\.partial|\.invalid)?$/

export async function pruneOldBackups(dir: string, retention: number): Promise<string[]> {
  let files: string[]
  try {
    files = readdirSync(dir)
      .filter(f => ARCHIVE_RE.test(f))
      .map(f => resolve(dir, f))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)   // oldest first
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      maintenanceLogger.info({ backupDir: dir }, 'Backup directory does not exist yet — nothing to prune')
      return []
    }
    throw err
  }

  if (files.length <= retention) return []

  const toDelete = files.slice(0, files.length - retention)
  for (const f of toDelete) {
    await unlink(f)
    maintenanceLogger.info({ file: f }, 'Deleted old backup')
  }
  return toDelete
}

// ── Backup + verification ────────────────────────────────────────────────────

async function backupAndVerify(): Promise<void> {
  const skipKeycloak = readSkipKeycloak()
  let archivePath: string
  try {
    const result = await runBackup({
      outputDir:     BACKUP_DIR,
      attachmentDir: config.attachmentDir,
      skipKeycloak,
      // Read lazily: keycloakAdminPassword throws when unset, and that must
      // surface as THIS backup's failure, not at worker start.
      keycloak: skipKeycloak ? undefined : {
        baseUrl:       config.keycloakUrl.replace(/\/+$/, ''),
        adminUser:     config.keycloakAdminUser,
        adminPassword: config.keycloakAdminPassword,
      },
      log: maintenanceLogger,
    })
    archivePath = result.archivePath
    maintenanceLogger.info({ archivePath, nodeCount: result.nodeCount, relCount: result.relCount, durationMs: result.durationMs }, 'Backup completed')
  } catch (err) {
    backupRunsTotal.inc({ result: 'backup_failed' })
    throw err
  }

  const report = await verifyBackup(archivePath)
  if (!report.ok) {
    const invalidPath = `${archivePath}.invalid`
    await rename(archivePath, invalidPath)
    backupRunsTotal.inc({ result: 'verify_failed' })
    maintenanceLogger.error({ archivePath: invalidPath, problems: report.problems, warnings: report.warnings }, 'Backup verification FAILED — archive renamed to .invalid, no valid backup produced tonight')
    throw new Error(`Backup verification failed for ${archivePath}: ${report.problems.join('; ')}`)
  }
  backupRunsTotal.inc({ result: 'ok' })
  backupLastSuccessTimestamp.set({}, Math.floor(Date.now() / 1000))
  maintenanceLogger.info({ archivePath, warnings: report.warnings, report: formatReport(report) }, 'Backup verified')
}

// ── Job processor ─────────────────────────────────────────────────────────────

async function processMaintenanceJob(job: Job): Promise<void> {
  maintenanceLogger.info({ jobName: job.name }, 'Processing maintenance job')

  switch (job.name) {
    case 'backup_database': {
      const retention = readBackupRetention()
      try {
        await backupAndVerify()
      } finally {
        // Rotation runs even after a failed/invalid backup: a broken night
        // must not stop the disk from being reclaimed.
        const deleted = await pruneOldBackups(BACKUP_DIR, retention)
        maintenanceLogger.info({ retention, deleted: deleted.length }, 'Old backups pruned')
      }
      break
    }

    case 'purge_events': {
      const r = await purgeResolvedEvents()
      maintenanceLogger.info({ tenants: r.tenants, purged: r.purged, perTenant: r.perTenant }, 'Resolved events purged (retention)')
      break
    }

    default:
      throw new Error(`Unknown maintenance job "${job.name}"`)
  }
}

// ── Schedule recurring jobs ───────────────────────────────────────────────────

async function scheduleRepeatableJobs(): Promise<void> {
  const maintenanceQueue = getQueue(MAINTENANCE_QUEUE)
  const names = new Set(REPEATABLE_JOBS.map((j) => j.name))

  // Remove any stale repeatable jobs first, then re-add
  const repeatableJobs = await maintenanceQueue.getRepeatableJobs()
  for (const job of repeatableJobs) {
    if (names.has(job.name)) {
      await maintenanceQueue.removeRepeatableByKey(job.key)
    }
  }

  for (const job of REPEATABLE_JOBS) {
    await maintenanceQueue.add(job.name, {}, { repeat: { pattern: job.pattern } })
    maintenanceLogger.info({ job: job.name, pattern: job.pattern }, `${job.name} job scheduled (${job.description})`)
  }
}

// ── Worker export ─────────────────────────────────────────────────────────────

/** Async: the schedule registration is awaited (a failure is a startup error, not an unhandled rejection). */
export async function startMaintenanceWorker(): Promise<Worker> {
  // Fail at boot on a malformed value, not at midnight.
  const retention = readBackupRetention()
  readSkipKeycloak()
  await scheduleRepeatableJobs()

  const worker = createWorker(MAINTENANCE_QUEUE, processMaintenanceJob, { concurrency: 1 })
  maintenanceLogger.info({ backupDir: BACKUP_DIR, retention }, 'Maintenance worker started')
  return worker
}
