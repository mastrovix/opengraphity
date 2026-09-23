/**
 * BullMQ worker that computes and stores embeddings for incidents and KB
 * articles, powering "similar incidents" and "suggested KB" (semantic search
 * on the Neo4j vector indexes).
 *
 * Jobs are enqueued on entity create/update and by the backfill script.
 * No-fallback: any failure (model load, provider HTTP, Neo4j) throws so the
 * job fails visibly and BullMQ retries.
 */
import { aiFeatureEnabled } from '../lib/aiSettings.js'
import type { Worker, Job } from 'bullmq'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import {
  getEmbedder,
  vectorIndexName,
  incidentEmbeddingText,
  kbEmbeddingText,
} from '../services/embeddings.js'

const log = logger.child({ module: 'embedding-worker' })

export interface EmbeddingJobData {
  entityType: 'incident' | 'kb_article'
  entityId:   string
  tenantId:   string
  /** ISO timestamp of the entity version being embedded (job-id versioning). */
  updatedAt?: string
}

export const EMBEDDINGS_QUEUE = 'embeddings'

/**
 * Job id versioned by the entity's updated_at (C-17): with a fixed
 * `embed:<type>:<id>` a still-present FAILED job for the entity made BullMQ
 * silently ignore the re-enqueue after an edit — the embedding stayed stale
 * until the failed job aged out. Callers that do not know updated_at get the
 * enqueue time, which has the same effect (a new version ⇒ a new job).
 */
export function embeddingJobId(data: EmbeddingJobData, now: number = Date.now()): string {
  const epoch = data.updatedAt ? Date.parse(data.updatedAt) : now
  if (Number.isNaN(epoch)) {
    throw new Error(`[embeddings] invalid updatedAt "${data.updatedAt}" for ${data.entityType} ${data.entityId}`)
  }
  return `embed-${data.entityType}-${data.entityId}-${epoch}`
}

/** Enqueue (or re-enqueue) the embedding of an entity, deduped per entity version. */
export async function enqueueEmbedding(data: EmbeddingJobData): Promise<void> {
  await getQueue<EmbeddingJobData>(EMBEDDINGS_QUEUE).add('embed', data, {
    jobId:            embeddingJobId(data),
    removeOnComplete: true,
    removeOnFail:     50,
    attempts:         3,
    backoff:          { type: 'exponential', delay: 5_000 },
  })
}

/** Where the embedding of an entity version stands, for a panel that waits for it (D15). */
export type EmbeddingRequest = { state: 'queued' } | { state: 'failed'; reason: string }

/**
 * Makes sure the embedding of this version of the entity is on its way, and
 * says so truthfully (tour of 23 Sep 2026, D15). The similarity panel said
 * «Analysis under way…» for ever on incidents whose embedding nobody had
 * queued (imported tickets, data written before the pipeline, an enqueue that
 * failed at creation): asking now queues it. A job that used up its attempts
 * is reported with its reason instead of being queued again behind the
 * reader's back; a new version of the entity gets a new job.
 */
export async function requestEmbedding(data: EmbeddingJobData & { updatedAt: string }): Promise<EmbeddingRequest> {
  const job = await getQueue<EmbeddingJobData>(EMBEDDINGS_QUEUE).getJob(embeddingJobId(data))
  if (job && await job.isFailed()) return { state: 'failed', reason: job.failedReason }
  if (!job) await enqueueEmbedding(data)
  return { state: 'queued' }
}

// ── Vector indexes ───────────────────────────────────────────────────────────

export async function ensureVectorIndexes(): Promise<void> {
  const dims = getEmbedder().dimensions
  const session = getSession(undefined, 'WRITE')
  try {
    for (const [label, index] of [
      ['Incident', vectorIndexName('Incident')],
      ['KBArticle', vectorIndexName('KBArticle')],
    ] as const) {
      await session.executeWrite((tx) => tx.run(`
        CREATE VECTOR INDEX ${index} IF NOT EXISTS
        FOR (n:${label}) ON n.embedding
        OPTIONS {indexConfig: {
          \`vector.dimensions\`: ${dims},
          \`vector.similarity_function\`: 'cosine'
        }}
      `))
    }
    log.info({ dims }, '[embeddings] vector indexes ensured')
  } finally {
    await session.close()
  }
}

// ── Processor ────────────────────────────────────────────────────────────────

async function processEmbedding(job: Job<EmbeddingJobData>): Promise<void> {
  const { entityType, entityId, tenantId } = job.data
  // Embedding spenti dall'organizzazione (ondata 6): il testo non va al provider.
  if (!(await aiFeatureEnabled(tenantId, 'embeddings'))) {
    log.info({ entityType, entityId, tenantId }, '[embeddings] turned off for this organization — skipped')
    return
  }
  const embedder = getEmbedder()
  const label = entityType === 'incident' ? 'Incident' : 'KBArticle'

  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (n:${label} {id: $entityId, tenant_id: $tenantId})
      RETURN properties(n) AS props
    `, { entityId, tenantId })

    if (!row) {
      // Deleted between enqueue and processing — a legitimate no-op, logged.
      log.warn({ entityType, entityId }, '[embeddings] entity no longer exists — skipped')
      return
    }

    const text = entityType === 'incident'
      ? incidentEmbeddingText(row.props)
      : kbEmbeddingText(row.props)
    if (!text) throw new Error(`[embeddings] ${label} ${entityId} has no embeddable text`)

    const [vector] = await embedder.embed([text])

    await session.executeWrite((tx) => tx.run(`
      MATCH (n:${label} {id: $entityId, tenant_id: $tenantId})
      CALL db.create.setNodeVectorProperty(n, 'embedding', $vector)
      SET n.embedding_model = $model,
          n.embedded_at = $now
    `, { entityId, tenantId, vector, model: `${embedder.provider}:${embedder.model}`, now: new Date().toISOString() }))

    log.info({ entityType, entityId, dims: vector.length }, '[embeddings] stored')
  } finally {
    await session.close()
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

/**
 * Ensures the vector indexes THEN starts the worker. Index creation failing
 * is a startup failure that propagates to the caller (index.ts → fatal),
 * instead of a detached rejection racing with an already-running worker.
 */
export async function startEmbeddingWorker(): Promise<Worker<EmbeddingJobData>> {
  await ensureVectorIndexes()
  getQueue<EmbeddingJobData>(EMBEDDINGS_QUEUE)  // producer singleton (metrics)

  return createWorker<EmbeddingJobData>(EMBEDDINGS_QUEUE, processEmbedding, {
    // The local ONNX model is CPU-bound — one job at a time keeps the API responsive.
    concurrency: 1,
    onFailed: (job, err) => {
      log.error({ jobId: job?.id, data: job?.data, err: err.message }, '[embeddings] job failed')
    },
  })
}
