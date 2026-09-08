/**
 * Seed demo delle relazioni DEPENDS_ON / HOSTED_ON tra APP-*, DB-*, DBINST-* e server.
 *
 * DISTRUTTIVO: prima di ricreare, CANCELLA tutte le relazioni DEPENDS_ON/HOSTED_ON
 * uscenti dai CI del tenant con nome APP-*, DB-*, DBINST-*. Per questo:
 *   - tenant obbligatorio (--tenant=<slug>), nessun default;
 *   - conferma esplicita --yes-delete;
 *   - rifiutato con NODE_ENV=production.
 *
 * Uso: pnpm --filter @opengraphity/api seed:relations -- --tenant=<slug> --yes-delete
 */
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { refuseInProduction, requireConfirmFlag, resolveTenantArg } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomSubset<T>(arr: T[], min: number, max: number): T[] {
  const n = min + Math.floor(Math.random() * (max - min + 1))
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(n, shuffled.length))
}

async function seed(TENANT_ID: string) {
  const session = getSession(undefined, neo4j.session.WRITE)

  // ── STEP 1: Load existing CIs ─────────────────────────────────────────────

  const load = async (type: string): Promise<string[]> => {
    const result = await session.run(
      `MATCH (c:ConfigurationItem {tenant_id: $tenantId, type: $type}) RETURN c.id AS id`,
      { tenantId: TENANT_ID, type }
    )
    return result.records.map((r) => r.get('id') as string)
  }

  const apps        = await load('application')
  const databases   = await load('database')
  const dbInstances = await load('database_instance')
  const servers     = await load('server')

  console.log(`Loaded: ${apps.length} apps, ${databases.length} databases, ${dbInstances.length} dbInstances, ${servers.length} servers`)

  if (servers.length === 0) throw new Error('No servers found')
  if (databases.length === 0) throw new Error('No databases found')
  if (dbInstances.length === 0) throw new Error('No database_instances found')
  if (apps.length === 0) throw new Error('No applications found')

  // ── STEP 4: Clean existing DEPENDS_ON / HOSTED_ON ─────────────────────────

  console.log('\nCleaning existing DEPENDS_ON/HOSTED_ON relations...')
  const cleanResult = await session.run(
    `MATCH (a:ConfigurationItem)-[r:DEPENDS_ON|HOSTED_ON]->(b:ConfigurationItem)
     WHERE a.tenant_id = $tenantId
       AND (a.name STARTS WITH 'APP-'
         OR a.name STARTS WITH 'DB-'
         OR a.name STARTS WITH 'DBINST-')
     DELETE r
     RETURN count(r) AS deleted`,
    { tenantId: TENANT_ID }
  )
  const deleted = (cleanResult.records[0].get('deleted') as { toNumber(): number }).toNumber()
  console.log(`  Deleted ${deleted} existing relations`)

  // ── STEP 2: DB chain — Database → DatabaseInstance → Server ──────────────

  console.log('\nStep 2: DB chain...')
  let dbToInst = 0
  let instToSrv = 0

  // Track which dbInstances have been used (prefer 1:1, but reuse if needed)
  const usedInstances = new Set<string>()
  const freeInstances = [...dbInstances]

  for (const dbId of databases) {
    let instId: string
    if (freeInstances.length > 0) {
      instId = freeInstances.shift()!
      usedInstances.add(instId)
    } else {
      // All instances used — reuse randomly
      instId = pick(dbInstances)
    }

    await session.run(
      `MATCH (db:ConfigurationItem {id: $dbId}), (inst:ConfigurationItem {id: $instId})
       MERGE (db)-[:DEPENDS_ON]->(inst)`,
      { dbId, instId }
    )
    dbToInst++
  }

  // Every database_instance → 1 server
  for (const instId of dbInstances) {
    const serverId = pick(servers)
    await session.run(
      `MATCH (inst:ConfigurationItem {id: $instId}), (srv:ConfigurationItem {id: $serverId})
       MERGE (inst)-[:HOSTED_ON]->(srv)`,
      { instId, serverId }
    )
    instToSrv++
  }

  console.log(`  DB→DBInstance: ${dbToInst}`)
  console.log(`  DBInstance→Server: ${instToSrv}`)

  // ── STEP 3: Applications ──────────────────────────────────────────────────

  console.log('\nStep 3: Applications...')
  let appToSrv = 0
  let appToDB = 0

  for (const appId of apps) {
    if (Math.random() < 0.40) {
      // Chain A (40%) — app → servers directly
      const targets = randomSubset(servers, 1, 3)
      for (const serverId of targets) {
        await session.run(
          `MATCH (app:ConfigurationItem {id: $appId}), (srv:ConfigurationItem {id: $serverId})
           MERGE (app)-[:DEPENDS_ON]->(srv)`,
          { appId, serverId }
        )
        appToSrv++
      }
    } else {
      // Chain B (60%) — app → databases
      const targets = randomSubset(databases, 1, 3)
      for (const dbId of targets) {
        await session.run(
          `MATCH (app:ConfigurationItem {id: $appId}), (db:ConfigurationItem {id: $dbId})
           MERGE (app)-[:DEPENDS_ON]->(db)`,
          { appId, dbId }
        )
        appToDB++
      }
    }

    const idx = apps.indexOf(appId) + 1
    if (idx % 40 === 0) console.log(`  ${idx}/${apps.length} apps processed...`)
  }

  console.log(`  App→Server (direct): ${appToSrv}`)
  console.log(`  App→Database: ${appToDB}`)

  await session.close()

  console.log('\n── Summary ─────────────────────────────────────────────')
  console.log(`  DB → DBInstance  (DEPENDS_ON) : ${dbToInst}`)
  console.log(`  DBInstance → Server (HOSTED_ON): ${instToSrv}`)
  console.log(`  App → Server    (DEPENDS_ON)  : ${appToSrv}`)
  console.log(`  App → Database  (DEPENDS_ON)  : ${appToDB}`)
  console.log(`  Total new relations            : ${dbToInst + instToSrv + appToSrv + appToDB}`)
}

runScript('seed-relations', async () => {
  refuseInProduction('seed-relations')
  const tenantId = resolveTenantArg()
  requireConfirmFlag('--yes-delete')
  await seed(tenantId)
})
