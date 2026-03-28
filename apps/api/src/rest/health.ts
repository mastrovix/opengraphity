import { Router, type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { Redis } from 'ioredis'

const router: ExpressRouter = Router()

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms),
    ),
  ])
}

async function checkNeo4j(): Promise<'ok' | 'error'> {
  const session = getSession()
  try {
    await withTimeout(session.run('RETURN 1'), 2_000)
    return 'ok'
  } catch {
    return 'error'
  } finally {
    await session.close()
  }
}

async function checkRedis(): Promise<'ok' | 'error'> {
  const client = new Redis({
    host:                 process.env['REDIS_HOST'] ?? 'localhost',
    port:                 parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
    lazyConnect:          true,
    maxRetriesPerRequest: 0,
  })
  try {
    await withTimeout(client.connect(), 2_000)
    await client.ping()
    return 'ok'
  } catch {
    return 'error'
  } finally {
    client.disconnect()
  }
}

router.get('/health', async (_req, res) => {
  const [neo4j, redis] = await Promise.all([checkNeo4j(), checkRedis()])

  const allOk = neo4j === 'ok' && redis === 'ok'

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version:   '0.1.0',
    services:  { neo4j, redis },
  })
})

export { router as healthRouter }
