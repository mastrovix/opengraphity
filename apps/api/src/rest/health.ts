import { Router, type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { getConnection } from '@opengraphity/events'

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

async function checkRabbitMQ(): Promise<'ok' | 'error'> {
  try {
    await withTimeout(getConnection(), 2_000)
    return 'ok'
  } catch {
    return 'error'
  }
}

router.get('/health', async (_req, res) => {
  const [neo4j, rabbitmq] = await Promise.all([checkNeo4j(), checkRabbitMQ()])

  const allOk = neo4j === 'ok' && rabbitmq === 'ok'

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version:   '0.1.0',
    services:  { neo4j, rabbitmq },
  })
})

export { router as healthRouter }
