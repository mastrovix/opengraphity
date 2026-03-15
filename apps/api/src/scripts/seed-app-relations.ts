import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'tenant-demo'

function pickDepCount(): number {
  const r = Math.random()
  if (r < 0.30) return 0
  if (r < 0.60) return 1
  if (r < 0.80) return 2
  if (r < 0.92) return 3
  return 4
}

async function seed() {
  const session = getSession(undefined, neo4j.session.WRITE)

  const result = await session.run(
    `MATCH (c:ConfigurationItem {tenant_id: $tenantId, type: 'application'})
     RETURN c.id AS id`,
    { tenantId: TENANT_ID }
  )
  const appIds = result.records.map((r) => r.get('id') as string)
  console.log(`Loaded ${appIds.length} applications`)

  // Track created pairs to avoid duplicates and reverse cycles
  // key: `${fromId}->${toId}`
  const created = new Set<string>()
  let total = 0

  for (const appId of appIds) {
    const count = pickDepCount()
    if (count === 0) continue

    const others = appIds.filter((id) => id !== appId)
    const shuffled = [...others].sort(() => Math.random() - 0.5)

    let added = 0
    for (const targetId of shuffled) {
      if (added >= count) break

      const forward  = `${appId}->${targetId}`
      const reverse  = `${targetId}->${appId}`

      // Skip if already created this edge or its reverse
      if (created.has(forward) || created.has(reverse)) continue

      await session.run(
        `MATCH (a:ConfigurationItem {id: $fromId}), (b:ConfigurationItem {id: $toId})
         MERGE (a)-[:DEPENDS_ON]->(b)`,
        { fromId: appId, toId: targetId }
      )

      created.add(forward)
      added++
      total++
    }
  }

  await session.close()
  console.log(`\nDone. App→App DEPENDS_ON relations created: ${total}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
