import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'tenant-demo'

function randomSubset<T>(arr: T[], min: number, max: number): T[] {
  const n = min + Math.floor(Math.random() * (max - min + 1))
  return [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length))
}

function pickAppDepCount(): number {
  const r = Math.random()
  if (r < 0.30) return 0
  if (r < 0.60) return 1
  if (r < 0.80) return 2
  if (r < 0.92) return 3
  return 4
}

async function seed() {
  const session = getSession(undefined, neo4j.session.WRITE)

  // ── STEP 1: Load CIs ────────────────────────────────────────────────────────

  const load = async (label: string): Promise<string[]> => {
    const r = await session.run(
      `MATCH (c {tenant_id: $tenantId}) WHERE $label IN labels(c) RETURN c.id AS id ORDER BY c.name`,
      { tenantId: TENANT_ID, label }
    )
    return r.records.map((rec) => rec.get('id') as string)
  }

  const apps        = await load('Application')
  const databases   = await load('Database')
  const dbInstances = await load('DatabaseInstance')
  const servers     = await load('Server')

  console.log(`Loaded: ${apps.length} apps, ${databases.length} databases, ${dbInstances.length} dbInstances, ${servers.length} servers`)

  if (!apps.length || !databases.length || !dbInstances.length || !servers.length) {
    throw new Error('Missing CI data — run seed scripts first')
  }

  let dbToDbi    = 0
  let dbiToSrv   = 0
  let appToSrv   = 0
  let appToDB    = 0
  let appToApp   = 0

  // ── STEP 2: DB → DBInstance → Server ────────────────────────────────────────

  console.log('\nStep 2: DB chain...')

  for (let i = 0; i < databases.length; i++) {
    const dbId  = databases[i]
    const dbiId = dbInstances[i % dbInstances.length]
    await session.run(
      `MATCH (db:Database {id: $dbId}), (dbi:DatabaseInstance {id: $dbiId})
       MERGE (db)-[:DEPENDS_ON]->(dbi)`,
      { dbId, dbiId }
    )
    dbToDbi++
  }

  for (let i = 0; i < dbInstances.length; i++) {
    const dbiId = dbInstances[i]
    const srvId = servers[i % servers.length]
    await session.run(
      `MATCH (dbi:DatabaseInstance {id: $dbiId}), (srv:Server {id: $srvId})
       MERGE (dbi)-[:HOSTED_ON]->(srv)`,
      { dbiId, srvId }
    )
    dbiToSrv++
  }

  console.log(`  DB→DBInstance: ${dbToDbi}`)
  console.log(`  DBInstance→Server: ${dbiToSrv}`)

  // ── STEP 3: Applications ────────────────────────────────────────────────────

  console.log('\nStep 3: Applications...')

  for (let i = 0; i < apps.length; i++) {
    const appId = apps[i]
    const r = Math.random()

    if (r < 0.30) {
      // Chain A only — direct to servers
      const targets = randomSubset(servers, 1, 3)
      for (const srvId of targets) {
        await session.run(
          `MATCH (a:Application {id: $appId}), (s:Server {id: $srvId})
           MERGE (a)-[:DEPENDS_ON]->(s)`,
          { appId, srvId }
        )
        appToSrv++
      }
    } else if (r < 0.60) {
      // Chain B only — via databases
      const targets = randomSubset(databases, 1, 3)
      for (const dbId of targets) {
        await session.run(
          `MATCH (a:Application {id: $appId}), (db:Database {id: $dbId})
           MERGE (a)-[:DEPENDS_ON]->(db)`,
          { appId, dbId }
        )
        appToDB++
      }
    } else {
      // Both chains
      const srvTargets = randomSubset(servers, 1, 2)
      for (const srvId of srvTargets) {
        await session.run(
          `MATCH (a:Application {id: $appId}), (s:Server {id: $srvId})
           MERGE (a)-[:DEPENDS_ON]->(s)`,
          { appId, srvId }
        )
        appToSrv++
      }
      const dbTargets = randomSubset(databases, 1, 2)
      for (const dbId of dbTargets) {
        await session.run(
          `MATCH (a:Application {id: $appId}), (db:Database {id: $dbId})
           MERGE (a)-[:DEPENDS_ON]->(db)`,
          { appId, dbId }
        )
        appToDB++
      }
    }

    if ((i + 1) % 60 === 0) console.log(`  ${i + 1}/${apps.length} apps processed...`)
  }

  console.log(`  App→Server (direct): ${appToSrv}`)
  console.log(`  App→Database: ${appToDB}`)

  // ── STEP 4: App → App dependencies ─────────────────────────────────────────

  console.log('\nStep 4: App→App dependencies...')

  const created = new Set<string>()

  for (const appId of apps) {
    const count = pickAppDepCount()
    if (count === 0) continue

    const others   = apps.filter((id) => id !== appId)
    const shuffled = [...others].sort(() => Math.random() - 0.5)

    let added = 0
    for (const targetId of shuffled) {
      if (added >= count) break
      const forward = `${appId}->${targetId}`
      const reverse = `${targetId}->${appId}`
      if (created.has(forward) || created.has(reverse)) continue

      await session.run(
        `MATCH (a:Application {id: $appId}), (b:Application {id: $targetId})
         MERGE (a)-[:DEPENDS_ON]->(b)`,
        { appId, targetId }
      )
      created.add(forward)
      added++
      appToApp++
    }
  }

  console.log(`  App→App: ${appToApp}`)

  await session.close()

  console.log('\n── Summary ──────────────────────────────────────────────')
  console.log(`  DB → DBInstance  (DEPENDS_ON) : ${dbToDbi}`)
  console.log(`  DBInstance → Server (HOSTED_ON): ${dbiToSrv}`)
  console.log(`  App → Server    (DEPENDS_ON)  : ${appToSrv}`)
  console.log(`  App → Database  (DEPENDS_ON)  : ${appToDB}`)
  console.log(`  App → App       (DEPENDS_ON)  : ${appToApp}`)
  console.log(`  Total                          : ${dbToDbi + dbiToSrv + appToSrv + appToDB + appToApp}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
