import { startServer } from './server.js'
import { createNotificationDispatcher } from '@opengraphity/notifications'
import { createSLAEngine } from '@opengraphity/sla'
import { closeConnection } from '@opengraphity/events'

async function main() {
  const httpServer = await startServer()

  // Start RabbitMQ consumers
  await createNotificationDispatcher()
  await createSLAEngine()

  console.log('[api] All consumers started')

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string) => {
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
