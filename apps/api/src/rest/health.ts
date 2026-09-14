import { Router, type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { getRedisConnection } from '@opengraphity/events'
import { Redis } from 'ioredis'
import { provisioningGaps } from '../lib/provisioningGauge.js'
import { pendingMigrations } from '../lib/migrationState.js'

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
  // Same connection (host/password/TLS) as the queues: a health check that
  // pinged a different Redis than the workers use would be meaningless.
  const client = new Redis({
    ...getRedisConnection(),
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

  // Revisione del 14 set 2026 · F8: con migrazioni pendenti il processo gira
  // su uno schema che non corrisponde al codice. Non è «ok», e si dice quante.
  const pending = neo4j === 'ok' ? await pendingMigrations().catch(() => [] as string[]) : []

  const allOk = neo4j === 'ok' && redis === 'ok' && pending.length === 0

  // Quali clienti sono incompleti (revisione delle otto ondate · D·D4). Non
  // cambia lo stato della sonda — un tenant da configurare non è un guasto del
  // processo — ma smette di essere una cosa che sa solo `migrate --status`:
  // finisce qui e nel gauge `tenant_provisioning_gaps`. Ricalcolato al massimo
  // ogni cinque minuti, e un database che non risponde non fa fallire /health.
  const gaps: Record<string, string[]> = neo4j === 'ok' ? await provisioningGaps().catch(() => ({})) : {}
  const incomplete = Object.entries(gaps).filter(([, g]) => g.length > 0)

  // SOLO IL NUMERO, non i nomi (terza revisione · M15). Questo endpoint sta
  // prima di qualunque autenticazione — e giusto, una sonda non ha un token —
  // e il campo elencava gli IDENTIFICATIVI DEI CLIENTI: una sonda di uptime o
  // un load balancer si portava via la lista dei tenant. Chi ha diritto ai nomi
  // li trova nel gauge `tenant_provisioning_gaps{tenant}` su `/metrics`, che un
  // token protegge — cioe il posto che il prodotto tratta già come sensibile.
  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version:   '0.1.0',
    services:  { neo4j, redis },
    ...(pending.length ? { pendingMigrations: pending.length } : {}),
    ...(incomplete.length ? { incompleteTenants: incomplete.length } : {}),
  })
})

export { router as healthRouter }
