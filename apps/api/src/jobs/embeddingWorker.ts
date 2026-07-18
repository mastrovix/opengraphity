/**
 * BullMQ worker that computes and stores embeddings for incidents and KB
 * articles, powering "similar incidents" and "suggested KB" (semantic search
 * on the Neo4j vector indexes).
 *
 * Jobs are enqueued on entity create/update and by the backfill script.
 * No-fallback: any failure (model load, provider HTTP, Neo4j) throws so the
 * job fails visibly and BullMQ retries.
 */
import { Worker, Queue, type Job } from 'bullmq'
import { getRedisOptions } from '@opengraphity/events'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
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
}

const QUEUE_NAME = 'embeddings'

let _queue: Queue | null = null
function getQueue(): Queue {
  _queue ??= new Queue(QUEUE_NAME, { connection: getRedisOptions() })
  return _queue
}

/** Enqueue (or re-enqueue) the embedding of an entity. Deduped per entity. */
export async function enqueueEmbedding(data: EmbeddingJobData): Promise<void> {
  await getQueue().add('embed', data, {
    jobId:            `embed:${data.entityType}:${data.entityId}`,
    removeOnComplete: true,
    removeOnFail:     50,
    attempts:         3,
    backoff:          { type: 'exponential', delay: 5_000 },
  })
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

export function startEmbeddingWorker(): Worker<EmbeddingJobData> {
  // Index creation is part of worker startup — failing here must fail startup,
  // not leave a worker that stores vectors no index will ever serve.
  void ensureVectorIndexes().catch((err: unknown) => {
    log.error({ err }, '[embeddings] FATAL: could not ensure vector indexes')
    throw err
  })

  const worker = new Worker<EmbeddingJobData>(QUEUE_NAME, processEmbedding, {
    connection:  getRedisOptions(),
    // The local ONNX model is CPU-bound — one job at a time keeps the API responsive.
    concurrency: 1,
  })

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, data: job?.data, err: err.message }, '[embeddings] job failed')
  })

  log.info('[embeddings] worker started')
  return worker
}
