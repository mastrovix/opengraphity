import { startServer } from './server.js'
import { createNotificationDispatcher } from '@opengraphity/notifications'
import { createSLAEngine } from '@opengraphity/sla'
import { closeConnection } from '@opengraphity/events'
import { startReportScheduler } from './jobs/reportScheduler.js'
import { startAnomalyScanner } from './anomaly/anomalyEngine.js'

async function main() {
  const httpServer = await startServer()

  // Start RabbitMQ consumers
  await createNotificationDispatcher()
  await createSLAEngine()

  // Start report scheduler (BullMQ, every 60s)
  startReportScheduler()

  // Start anomaly scanner (BullMQ, every 1h)
  startAnomalyScanner()

  console.log('[api] All consumers started')

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[api] Received ${signal} — shutting down gracefully...`)
    httpServer.close(() => {
      console.log('[api] HTTP server closed')
    })
    await closeConnection()
    console.log('[api] RabbitMQ connection closed')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT',  () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  console.error('[api] Fatal startup error:', err)
  process.exit(1)
})
