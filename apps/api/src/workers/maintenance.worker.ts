import { Worker, Queue, type Job } from 'bullmq'
import { readdirSync, statSync }  from 'node:fs'
import { resolve }                from 'node:path'
import { unlink }                 from 'node:fs/promises'
import { getRedisOptions }        from '@opengraphity/events'
import { runBackup }              from '../scripts/backup-neo4j.js'
import { logger }                 from '../lib/logger.js'

const maintenanceLogger = logger.child({ module: 'maintenance' })

const BACKUP_DIR      = resolve(process.env['BACKUP_DIR'] ?? './backups')
const RETENTION_COUNT = 7

// ── Queue ─────────────────────────────────────────────────────────────────────

const maintenanceQueue = new Queue('maintenance', {
  connection: getRedisOptions(),
})

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
  } catch {
    return   // directory may not exist yet
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

export function startMaintenanceWorker(): Worker {
  void scheduleBackupJob()

  const worker = new Worker('maintenance', processMaintenanceJob, {
    connection:  getRedisOptions(),
    concurrency: 1,
  })

  worker.on('failed', (job, err) => {
    maintenanceLogger.error({ jobName: job?.name, err: err.message }, 'Maintenance job failed')
  })

  maintenanceLogger.info({ backupDir: BACKUP_DIR }, 'Maintenance worker started')
  return worker
}
