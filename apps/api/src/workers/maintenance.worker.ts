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
import { pruneInbox } from '@opengraphity/notifications'
import { inAppRetentionByTenant } from '../lib/tenantInAppRetention.js'
import { purgaIRegistriDeiLog, leggiGiorniDiRetention } from '../services/serverLogRetention.js'
import { immettiEventiDaiLog } from '../lib/serverLogEvents.js'

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
  // Revisione del 14 set 2026 · F10: le notifiche in-app salvate si puliscono per età.
  { name: 'purge_inapp_notifications', pattern: '45 3 * * *', description: 'daily at 03:45' },
  /**
   * Moduli del catalogo, ondata 2: le BOZZE mai reclamate. Un campo allegato
   * si compila prima che la richiesta esista, quindi i file si caricano su una
   * bozza; se chi compilava cambia idea e chiude la pagina, quei file restano.
   * Senza questa passata crescerebbero per sempre — su disco e nel grafo.
   */
  { name: 'purge_form_drafts', pattern: '15 4 * * *', description: 'daily at 04:15' },
  /**
   * I DUE REGISTRI DEI LOG (20 set 2026, ondata 3). `:ServerLogEntry` è
   * l'archivio nuovo su cui il prodotto guarda sé stesso; `:LogEntry` sono i
   * log del browser, che esistono da sempre e non sono MAI stati purgati —
   * 270.000 nodi, nessun lettore, nessun indice. Un registro che cresce senza
   * che nessuno abbia deciso per quanto è un difetto, non un archivio.
   */
  { name: 'purge_server_logs', pattern: '0 5 * * *', description: 'daily at 05:00' },
  /**
   * DA ERRORE A EVENTO (ondata 3). Ogni quarto d'ora, non di notte: un guasto
   * in corso non aspetta le cinque del mattino. Un quarto d'ora è il
   * compromesso fra «te ne accorgi presto» e «non apri un incident per un
   * errore isolato» — la soglia acuta (20 occorrenze in un giorno) fa il
   * resto del filtro, e la pipeline degli eventi ha già la sua deduplica.
   */
  { name: 'server_logs_to_events', pattern: '*/15 * * * *', description: 'every 15 minutes' },
]

/**
 * Quanto si aspetta prima di cancellare una bozza mai reclamata. Un giorno: il
 * tempo di compilare un modulo con calma, riaprire la pagina, finire domani
 * mattina. Non è configurabile perché non è una scelta del cliente: è la
 * durata di una sessione di compilazione.
 */
export const FORM_DRAFT_MAX_AGE_HOURS = 24

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

    case 'purge_form_drafts': {
      const prima = new Date(Date.now() - FORM_DRAFT_MAX_AGE_HOURS * 3_600_000).toISOString()
      const { purgeFormDrafts } = await import('../lib/formDraftPurge.js')
      const r = await purgeFormDrafts(prima)
      if (r.nodes > 0 || r.filesFailed > 0) {
        maintenanceLogger.info({ ...r, olderThan: prima }, 'Unclaimed form draft attachments purged')
      }
      if (r.filesFailed > 0) {
        // Il nodo è andato ma il file no: lo si dice, perché lo spazio non
        // torna e nessun altro passerà da lì.
        maintenanceLogger.warn({ filesFailed: r.filesFailed }, 'Some form draft files could not be deleted from disk')
      }
      break
    }

    case 'purge_inapp_notifications': {
      // La durata è di ogni organizzazione (verifica «Cosa resta cablato»,
      // ondata 2). Chi non l'ha scelta viene saltato e lo si dice: cancellare
      // con una durata che nessuno ha deciso non è un ripiego accettabile.
      for (const { tenantId, days } of await inAppRetentionByTenant()) {
        if (days === null) {
          maintenanceLogger.warn({ tenantId }, 'In-app notifications NOT pruned: the organization has not chosen how long to keep them (Settings → Organization)')
          continue
        }
        const before = new Date(Date.now() - days * 86_400_000).toISOString()
        const deleted = await pruneInbox(tenantId, before)
        maintenanceLogger.info({ tenantId, deleted, retentionDays: days, before }, 'In-app notifications pruned')
      }
      break
    }

    case 'server_logs_to_events': {
      const { immessi, esaminate } = await immettiEventiDaiLog()
      if (immessi > 0) maintenanceLogger.info({ immessi, esaminate }, 'Server log signatures turned into monitoring events')
      break
    }

    case 'purge_server_logs': {
      const { server, browser, giorni } = await purgaIRegistriDeiLog()
      maintenanceLogger.info({ server, browser, retentionDays: giorni }, 'Server and browser log registries pruned')
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
  // Stessa regola per la durata dei log: se è scritta male lo si scopre ora,
  // non alle cinque del mattino con il job che fallisce in silenzio.
  leggiGiorniDiRetention()
  await scheduleRepeatableJobs()

  const worker = createWorker(MAINTENANCE_QUEUE, processMaintenanceJob, { concurrency: 1 })
  maintenanceLogger.info({ backupDir: BACKUP_DIR, retention }, 'Maintenance worker started')
  return worker
}
