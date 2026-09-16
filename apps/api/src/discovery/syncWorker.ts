import type { Worker, Job } from 'bullmq'
import { config } from '../lib/config.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import {
  decryptCredentials,
  getConnector,
} from '@opengraphity/discovery'
import type { SyncSourceConfig } from '@opengraphity/discovery'
import { logger } from '../lib/logger.js'
import { reconcileBatch, markStale, type ReconciliationStats } from './reconciliationEngine.js'
import { publish } from '@opengraphity/events'
import { createWorker, getQueue } from '../lib/bullmq.js'

function encryptionKey(): string {
  const k = config.discoveryEncryptionKey
  if (!k) throw new Error('DISCOVERY_ENCRYPTION_KEY is not set — cannot process discovery credentials')
  return k
}
const BATCH_SIZE     = 50

// ── Job payload ───────────────────────────────────────────────────────────────

interface SyncJobPayload {
  runId:    string
  sourceId: string
  tenantId: string
  syncType: string
}

// ── Queue export (used by sync.ts resolver to enqueue) ────────────────────────

export const syncQueue = getQueue<SyncJobPayload>('discovery-sync')

// ── Processor ─────────────────────────────────────────────────────────────────

async function processSyncJob(job: Job<SyncJobPayload>): Promise<void> {
  const { sourceId, tenantId } = job.data
  const startedAt = Date.now()
  // Revisione totale · D-5: un'esecuzione = un `SyncRun`. I job del cron
  // portavano un runId fisso (`scheduled-<id>`) senza nodo, quindi
  // `updateRunStatus` non scriveva niente: la pagina «Esecuzioni» non mostrava
  // nessuna sincronizzazione automatica, le statistiche le ignoravano e un
  // fallimento notturno non lasciava né errore né numeri. Ogni job crea il suo
  // nodo se non ce l'ha (quello manuale lo crea la mutation, con lo stato
  // `queued`).
  const runId = await ensureRun(job.data, startedAt)

  logger.info({ runId, sourceId, tenantId, jobId: job.id }, '[sync] Starting sync job')

  // ── Load source config from Neo4j ─────────────────────────────────────────
  const session = getSession()
  let source: SyncSourceConfig
  let encryptedCreds: string

  try {
    type Row = { props: Record<string, unknown>; enc: string }
    const row = await runQueryOne<Row>(session,
      `MATCH (s:SyncSource {id: $id, tenant_id: $tenantId})
       RETURN properties(s) AS props, s.encrypted_credentials AS enc`,
      { id: sourceId, tenantId },
    )

    if (!row) {
      throw new Error(`SyncSource ${sourceId} not found`)
    }

    encryptedCreds = row.enc
    const p = row.props
    source = {
      id:                    p['id']               as string,
      tenant_id:             p['tenant_id']         as string,
      name:                  p['name']              as string,
      connector_type:        p['connector_type']    as string,
      encrypted_credentials: encryptedCreds,
      config:                JSON.parse(p['config']         as string ?? '{}') as Record<string, unknown>,
      mapping_rules:         JSON.parse(p['mapping_rules']  as string ?? '[]'),
      schedule_cron:         (p['schedule_cron']     as string | null | undefined) ?? null,
      enabled:               Boolean(p['enabled']),
      last_sync_at:          (p['last_sync_at']      as string | null | undefined) ?? null,
      last_sync_status:      ((p['last_sync_status']  as 'completed' | 'failed' | null | undefined) ?? null),
      last_sync_duration_ms: (p['last_sync_duration_ms'] as number | null | undefined) ?? null,
      created_at:            p['created_at']        as string,
      updated_at:            p['updated_at']        as string,
    }
  } finally {
    await session.close()
  }

  // ── Get connector ─────────────────────────────────────────────────────────
  const connector = getConnector(source.connector_type)
  if (!connector) {
    await updateRunStatus(runId, tenantId, 'failed', 0, `Connector "${source.connector_type}" not registered`)
    return
  }

  // ── Decrypt credentials ───────────────────────────────────────────────────
  let creds: Record<string, string>
  try {
    creds = decryptCredentials(encryptedCreds, encryptionKey())
  } catch (err) {
    // Permanent config error (bad key): record and stop — retrying won't help,
    // but it must be loud.
    logger.error({ err, runId, sourceId }, '[sync] Credential decryption failed')
    await updateRunStatus(runId, tenantId, 'failed', 0, `Failed to decrypt credentials: ${String(err)}`)
    return
  }

  // ── Mark run as running ───────────────────────────────────────────────────
  await updateRunStatus(runId, tenantId, 'running', 0)

  // ── Stream and reconcile CIs ──────────────────────────────────────────────
  const stats: ReconciliationStats = {
    ciCreated: 0, ciUpdated: 0, ciUnchanged: 0, ciStale: 0,
    ciConflicts: 0, relationsCreated: 0, relationsRemoved: 0,
  }

  const seenExternalIds = new Set<string>()
  let batch: import('@opengraphity/discovery').DiscoveredCI[] = []

  try {
    for await (const ci of connector.scan(source, creds)) {
      seenExternalIds.add(ci.external_id)
      batch.push(ci)

      if (batch.length >= BATCH_SIZE) {
        await reconcileBatch(batch, source, runId, tenantId, stats)
        await job.updateProgress(Math.round((seenExternalIds.size / Math.max(seenExternalIds.size, 1)) * 50))
        batch = []
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      await reconcileBatch(batch, source, runId, tenantId, stats)
    }

    // ── Stale detection ────────────────────────────────────────────────────
    stats.ciStale = await markStale(sourceId, tenantId, runId, seenExternalIds)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err, runId, sourceId }, '[sync] Scan error')
    await updateRunStatus(runId, tenantId, 'failed', Date.now() - startedAt, msg, stats)
    await updateSourceMeta(sourceId, tenantId, 'failed')
    await publishSyncEvent('sync.failed', { runId, sourceId, tenantId, error: msg, stats })
    // Transient provider/network errors must let BullMQ retry.
    throw err
  }

  const durationMs = Date.now() - startedAt
  await updateRunStatus(runId, tenantId, 'completed', durationMs, undefined, stats)
  await updateSourceMeta(sourceId, tenantId, 'completed', durationMs)
  await publishSyncEvent('sync.completed', { runId, sourceId, tenantId, stats })

  logger.info({ runId, sourceId, durationMs, ...stats }, '[sync] Sync completed')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Il nodo `SyncRun` dell'esecuzione. Il job manuale ne porta uno già creato
 * dalla mutation; quello del cron no, e ne nasce uno per ogni scatto (D-5).
 */
async function ensureRun(data: SyncJobPayload, startedAtMs: number): Promise<string> {
  const { runId, sourceId, tenantId, syncType } = data
  const now = new Date(startedAtMs).toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    const existing = await runQueryOne<{ id: string }>(session,
      'MATCH (r:SyncRun {id: $runId, tenant_id: $tenantId}) RETURN r.id AS id', { runId, tenantId })
    if (existing) return runId
    const id = `${runId}-${String(startedAtMs)}`
    await runQuery(session, `
      CREATE (r:SyncRun {
        id: $id, source_id: $sourceId, tenant_id: $tenantId,
        sync_type: $syncType, status: 'running',
        ci_created: 0, ci_updated: 0, ci_unchanged: 0, ci_stale: 0, ci_conflicts: 0,
        relations_created: 0, relations_removed: 0,
        started_at: $now, updated_at: $now
      })
    `, { id, sourceId, tenantId, syncType: syncType ?? 'scheduled', now })
    return id
  } finally {
    await session.close()
  }
}

async function updateRunStatus(
  runId:      string,
  tenantId:   string,
  status:     string,
  durationMs: number,
  errorMsg?:  string,
  stats?:     ReconciliationStats,
): Promise<void> {
  const now = new Date().toISOString()
  const s   = getSession()
  try {
    await s.executeWrite(tx => tx.run(
      `MATCH (r:SyncRun {id: $runId, tenant_id: $tenantId})
       SET r.status       = $status,
           r.duration_ms  = $durationMs,
           r.error_message = $errorMsg,
           r.completed_at = $completedAt,
           r.ci_created   = $ciCreated,
           r.ci_updated   = $ciUpdated,
           r.ci_unchanged = $ciUnchanged,
           r.ci_stale     = $ciStale,
           r.ci_conflicts = $ciConflicts,
           r.relations_created = $relCreated,
           r.relations_removed = $relRemoved,
           r.updated_at   = $now`,
      {
        runId, tenantId, status, durationMs, now,
        errorMsg:   errorMsg ?? null,
        completedAt: status !== 'running' ? now : null,
        ciCreated:    stats?.ciCreated       ?? 0,
        ciUpdated:    stats?.ciUpdated       ?? 0,
        ciUnchanged:  stats?.ciUnchanged     ?? 0,
        ciStale:      stats?.ciStale         ?? 0,
        ciConflicts:  stats?.ciConflicts     ?? 0,
        relCreated:   stats?.relationsCreated ?? 0,
        relRemoved:   stats?.relationsRemoved ?? 0,
      },
    ))
  } finally {
    await s.close()
  }
}

async function updateSourceMeta(
  sourceId:   string,
  tenantId:   string,
  status:     string,
  durationMs?: number,
): Promise<void> {
  const now = new Date().toISOString()
  const s   = getSession()
  try {
    await s.executeWrite(tx => tx.run(
      `MATCH (n:SyncSource {id: $sourceId, tenant_id: $tenantId})
       SET n.last_sync_at = $now, n.last_sync_status = $status,
           n.last_sync_duration_ms = $durationMs, n.updated_at = $now`,
      { sourceId, tenantId, now, status, durationMs: durationMs ?? null },
    ))
  } finally {
    await s.close()
  }
}

async function publishSyncEvent(
  eventType: string,
  payload:   Record<string, unknown>,
): Promise<void> {
  try {
    await publish({
      id:             `${eventType}-${Date.now()}`,
      type:           eventType,
      tenant_id:      String(payload['tenantId'] ?? ''),
      timestamp:      new Date().toISOString(),
      correlation_id: String(payload['runId'] ?? ''),
      actor_id:       'system',
      payload,
    })
  } catch (err) {
    logger.warn({ err, eventType }, '[sync] Failed to publish event')
  }
}

// ── Queue & Worker setup ──────────────────────────────────────────────────────

export function startSyncWorker(): Worker<SyncJobPayload> {
  // createWorker registra on('error') (un blip Redis non abbatte l'API) e on('failed')
  const worker = createWorker<SyncJobPayload>('discovery-sync', processSyncJob, { concurrency: 2 })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, '[sync] Worker job completed')
  })

  logger.info('[sync] Sync worker started (concurrency: 2)')
  return worker
}

// ── Scheduled sync loader ─────────────────────────────────────────────────────

/** Il nome del repeat job di una sorgente: uno solo per sorgente. */
export function scheduledSyncJobId(sourceId: string): string {
  return `sync-scheduled-${sourceId}`
}

/**
 * Registra (o rimuove) il cron di UNA sorgente (revisione totale · D-6/D-7).
 * Prima `deleteSyncSource` e `updateSyncSource` non toccavano il repeat job:
 * un cron cancellato continuava a scattare per sempre (i repeatable vivono in
 * Redis, anche dopo un riavvio) e ogni scatto falliva con «SyncSource not
 * found»; cambiando il cron, dopo un riavvio giravano ENTRAMBI.
 */
export async function scheduleSourceSync(source: { id: string; tenantId: string; cron: string | null; enabled: boolean }): Promise<void> {
  const jobId = scheduledSyncJobId(source.id)
  // Il repeatable si toglie sempre: così un cron cambiato non lascia in piedi il vecchio.
  for (const job of await syncQueue.getRepeatableJobs()) {
    if (job.name === 'sync' && (job.id === jobId || job.key.includes(jobId))) {
      await syncQueue.removeRepeatableByKey(job.key)
    }
  }
  if (!source.enabled || !source.cron) {
    logger.info({ sourceId: source.id }, '[sync] scheduled sync removed (source disabled or without cron)')
    return
  }
  await syncQueue.add(
    'sync',
    { runId: `scheduled-${source.id}`, sourceId: source.id, tenantId: source.tenantId, syncType: 'scheduled' },
    { repeat: { pattern: source.cron }, jobId, removeOnComplete: 50, removeOnFail: 20 },
  )
  logger.info({ sourceId: source.id, cron: source.cron }, '[sync] scheduled sync registered')
}

export async function loadScheduledSyncs(): Promise<void> {
  const session = getSession()
  try {
    const result = await session.executeRead(tx => tx.run(
      `MATCH (s:SyncSource) WHERE s.enabled = true AND s.schedule_cron IS NOT NULL
       RETURN s.id AS id, s.tenant_id AS tenantId, s.schedule_cron AS cron`,
    ))

    for (const r of result.records) {
      const sourceId  = r.get('id')       as string
      const tenantId  = r.get('tenantId') as string
      const cron      = r.get('cron')     as string

      // Un cron corrotto non deve impedire l'avvio dell'API (D-7): si dice
      // nel log e le altre sorgenti partono comunque.
      try {
        await scheduleSourceSync({ id: sourceId, tenantId, cron, enabled: true })
      } catch (err) {
        logger.error({ err, sourceId, cron }, '[sync] scheduled sync NOT registered: fix the cron of this source')
      }
    }

    logger.info({ count: result.records.length }, '[sync] Scheduled syncs loaded')
  } catch (err) {
    logger.error({ err }, '[sync] Failed to load scheduled syncs')
    throw err
  } finally {
    await session.close()
  }
}
