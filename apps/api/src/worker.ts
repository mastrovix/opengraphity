/**
 * Standalone worker process.
 *
 * The embedding worker runs a CPU-bound ONNX model. In the API process that
 * inference blocks the single Node event loop, adding latency to every request.
 * Running it here — same image, separate container (see infra/docker-compose.yml
 * `worker` service) — keeps the API responsive and lets the two scale
 * independently. The API skips its own embedding worker when
 * EMBEDDING_WORKER_EXTERNAL=true.
 */
import { closeDriver, registerSessionTracker } from '@opengraphity/neo4j'
import { closeConnection } from '@opengraphity/events'
import { neo4jQueryDurationSeconds, recordSlowQuery } from './middleware/metrics.js'
import { startEmbeddingWorker } from './jobs/embeddingWorker.js'
import { logger } from './lib/logger.js'
import type { Worker } from 'bullmq'

registerSessionTracker((durationMs, query) => {
  neo4jQueryDurationSeconds.observe({ operation: 'QUERY' }, durationMs / 1000)
  if (durationMs > 500) recordSlowQuery(query || 'unknown', durationMs)
})

async function main() {
  const workers: Worker[] = [startEmbeddingWorker()]
  logger.info('Worker process started — embedding worker running')

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Worker received signal — shutting down gracefully')

    const closeAll = Promise.all(workers.map((w) => w.close()))
    const timedOut = await Promise.race([
      closeAll.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30_000)),
    ])
    logger.info(timedOut ? 'Worker close timed out after 30s' : 'Workers closed')

    await closeConnection()
    await closeDriver()
    logger.info('Worker graceful shutdown completed')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal worker startup error')
  process.exit(1)
})
