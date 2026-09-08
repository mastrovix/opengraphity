import type { Worker, Job } from 'bullmq'
import { readdirSync, statSync }  from 'node:fs'
import { resolve }                from 'node:path'
import { unlink }                 from 'node:fs/promises'
import { runBackup }              from '../scripts/backup-neo4j.js'
import { logger }                 from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'

const maintenanceLogger = logger.child({ module: 'maintenance' })

const BACKUP_DIR      = resolve(process.env['BACKUP_DIR'] ?? './backups')
const RETENTION_COUNT = 7

export const MAINTENANCE_QUEUE = 'maintenance'

// ── Retention: keep last N backups ────────────────────────────────────────────

async function pruneOldBackups(): Promise<void> {
  let files: string[]
  try {
    files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup_') && f.endsWith('.tar.gz'))
      .map(f => resolve(BACKUP_DIR, f))
      .sort((a, b) => {
        const mtimeA = statSync(a).mtimeMs
        const mtimeB = statSync(b).mtimeMs
        return mtimeA - mtimeB   // oldest first
      })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      maintenanceLogger.info({ backupDir: BACKUP_DIR }, 'Backup directory does not exist yet — nothing to prune')
      return
    }
    throw err
  }

  if (files.length <= RETENTION_COUNT) return

  const toDelete = files.slice(0, files.length - RETENTION_COUNT)
  for (const f of toDelete) {
    await unlink(f)
    maintenanceLogger.info({ file: f }, 'Deleted old backup')
  }
}

// ── Job processor ─────────────────────────────────────────────────────────────

async function processMaintenanceJob(job: Job): Promise<void> {
  maintenanceLogger.info({ jobName: job.name }, 'Processing maintenance job')

  switch (job.name) {
    case 'backup_database': {
      const result = await runBackup(BACKUP_DIR)
      maintenanceLogger.info(result, 'Backup completed')
      await pruneOldBackups()
      maintenanceLogger.info({ retentionCount: RETENTION_COUNT }, 'Old backups pruned')
      break
    }

    default:
      maintenanceLogger.warn({ jobName: job.name }, 'Unknown maintenance job — skipped')
  }
}

// ── Schedule recurring backup ─────────────────────────────────────────────────

async function scheduleBackupJob(): Promise<void> {
  const maintenanceQueue = getQueue(MAINTENANCE_QUEUE)

  // Remove any stale repeatable jobs first, then re-add
  const repeatableJobs = await maintenanceQueue.getRepeatableJobs()
  for (const job of repeatableJobs) {
    if (job.name === 'backup_database') {
      await maintenanceQueue.removeRepeatableByKey(job.key)
    }
  }

  await maintenanceQueue.add(
    'backup_database',
    {},
    {
      repeat: { pattern: '0 0 * * *' },   // every day at midnight
    },
  )

  maintenanceLogger.info('Backup job scheduled (daily at midnight)')
}

// ── Worker export ─────────────────────────────────────────────────────────────

/** Async: the schedule registration is awaited (a failure is a startup error, not an unhandled rejection). */
export async function startMaintenanceWorker(): Promise<Worker> {
  await scheduleBackupJob()

  const worker = createWorker(MAINTENANCE_QUEUE, processMaintenanceJob, { concurrency: 1 })
  maintenanceLogger.info({ backupDir: BACKUP_DIR }, 'Maintenance worker started')
  return worker
}
