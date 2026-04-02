import { Queue, Worker, type Job } from 'bullmq'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import {
  decryptCredentials,
  getConnector,
  applyMappingRules,
} from '@opengraphity/discovery'
import type { SyncSourceConfig } from '@opengraphity/discovery'
import { logger } from '../lib/logger.js'
import { reconcileBatch, markStale, type ReconciliationStats } from './reconciliationEngine.js'
import { publish } from '@opengraphity/events'

// ── Redis connection ──────────────────────────────────────────────────────────

const connection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
}

const ENCRYPTION_KEY = process.env['DISCOVERY_ENCRYPTION_KEY'] ?? ''
const BATCH_SIZE     = 50

// ── Job payload ───────────────────────────────────────────────────────────────

interface SyncJobPayload {
  runId:    string
  sourceId: string
  tenantId: string
  syncType: string
}

// ── Queue export (used by sync.ts resolver to enqueue) ────────────────────────

export const syncQueue = new Queue<SyncJobPayload>('discovery-sync', { connection })

// ── Processor ─────────────────────────────────────────────────────────────────

async function processSyncJob(job: Job<SyncJobPayload>): Promise<void> {
  const { runId, sourceId, tenantId, syncType } = job.data
  const startedAt = Date.now()

  logger.info({ runId, sourceId, tenantId }, '[sync] Starting sync job')

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
    await updateRunStatus(runId, 'failed', 0, `Connector "${source.connector_type}" not registered`)
    return
  }

  // ── Decrypt credentials ───────────────────────────────────────────────────
  let creds: Record<string, string>
  try {
    creds = decryptCredentials(encryptedCreds, ENCRYPTION_KEY)
  } catch (err) {
    await updateRunStatus(runId, 'failed', 0, `Failed to decrypt credentials: ${String(err)}`)
    return
  }

  // ── Mark run as running ───────────────────────────────────────────────────
  await updateRunStatus(runId, 'running', 0)

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
    await updateRunStatus(runId, 'failed', Date.now() - startedAt, msg, stats)
    await updateSourceMeta(sourceId, 'failed')
    await publishSyncEvent('sync.failed', { runId, sourceId, tenantId, error: msg, stats })
    return
  }

  const durationMs = Date.now() - startedAt
  await updateRunStatus(runId, 'completed', durationMs, undefined, stats)
  await updateSourceMeta(sourceId, 'completed', durationMs)
  await publishSyncEvent('sync.completed', { runId, sourceId, tenantId, stats })

  logger.info({ runId, sourceId, durationMs, ...stats }, '[sync] Sync completed')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateRunStatus(
  runId:      string,
  status:     string,
  durationMs: number,
  errorMsg?:  string,
  stats?:     ReconciliationStats,
): Promise<void> {
  const now = new Date().toISOString()
  const s   = getSession()
  try {
    await s.executeWrite(tx => tx.run(
      `MATCH (r:SyncRun {id: $runId})
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
        runId, status, durationMs, now,
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
  status:     string,
  durationMs?: number,
): Promise<void> {
  const now = new Date().toISOString()
  const s   = getSession()
  try {
    await s.executeWrite(tx => tx.run(
      `MATCH (n:SyncSource {id: $sourceId})
       SET n.last_sync_at = $now, n.last_sync_status = $status,
           n.last_sync_duration_ms = $durationMs, n.updated_at = $now`,
      { sourceId, now, status, durationMs: durationMs ?? null },
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

export function startSyncWorker(): void {
  const worker = new Worker<SyncJobPayload>(
    'discovery-sync',
    processSyncJob,
    { connection, concurrency: 2 },
  )

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, '[sync] Worker job failed')
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, '[sync] Worker job completed')
  })

  logger.info('[sync] Sync worker started (concurrency: 2)')
}

// ── Scheduled sync loader ─────────────────────────────────────────────────────

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

      await syncQueue.add(
        'sync',
        { runId: `scheduled-${sourceId}`, sourceId, tenantId, syncType: 'scheduled' },
        {
          repeat:  { pattern: cron },
          jobId:   `sync-scheduled-${sourceId}`,
          removeOnComplete: 50,
          removeOnFail:     20,
        },
      )

      logger.debug({ sourceId, cron }, '[sync] Scheduled sync registered')
    }

    logger.info({ count: result.records.length }, '[sync] Scheduled syncs loaded')
  } catch (err) {
    logger.error({ err }, '[sync] Failed to load scheduled syncs')
  } finally {
    await session.close()
  }
}
