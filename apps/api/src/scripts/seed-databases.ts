import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'tenant-demo'

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomSubset<T>(arr: T[], min: number, max: number): T[] {
  const n = min + Math.floor(Math.random() * (max - min + 1))
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(n, shuffled.length))
}

function randomDateInPast2Years(): string {
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000
  return new Date(Date.now() - Math.random() * twoYearsMs).toISOString()
}

function pickEnvironment(): string {
  const r = Math.random()
  if (r < 0.40) return 'production'
  if (r < 0.75) return 'staging'
  return 'development'
}

function pickStatus(): string {
  const r = Math.random()
  if (r < 0.80) return 'active'
  if (r < 0.95) return 'maintenance'
  return 'inactive'
}

async function seed() {
  const session = getSession(undefined, neo4j.session.WRITE)

  // Load teams
  const teamsResult = await session.run(
    `MATCH (t:Team {tenant_id: $tenantId}) RETURN t.id AS id`,
    { tenantId: TENANT_ID }
  )
  const teamIds = teamsResult.records.map((r) => r.get('id') as string)
  if (teamIds.length === 0) throw new Error('No teams found for tenant-demo')

  // Load servers
  const serversResult = await session.run(
    `MATCH (c:ConfigurationItem {tenant_id: $tenantId})
     WHERE c.type IN ['server', 'virtual_machine']
     RETURN c.id AS id`,
    { tenantId: TENANT_ID }
  )
  const serverIds = serversResult.records.map((r) => r.get('id') as string)
  if (serverIds.length === 0) throw new Error('No server CIs found for tenant-demo')

  let created = 0
  let skipped = 0

  for (let i = 1; i <= 400; i++) {
    const name          = `DB-${String(i).padStart(3, '0')}`
    const id            = uuidv4()
    const environment   = pickEnvironment()
    const status        = pickStatus()
    const createdAt     = randomDateInPast2Years()
    const ownerTeamId   = pick(teamIds)
    const supportTeamId = pick(teamIds)
    const depServerIds  = randomSubset(serverIds, 1, 2)

    const result = await session.run(
      `MERGE (c:ConfigurationItem {name: $name, tenant_id: $tenantId})
       ON CREATE SET
         c.id          = $id,
         c.type        = 'database',
         c.environment = $environment,
         c.status      = $status,
         c.description = $description,
         c.tenant_id   = $tenantId,
         c.created_at  = $createdAt,
         c.updated_at  = $createdAt
       RETURN c.id AS id, (c.created_at = $createdAt) AS wasCreated`,
      {
        name,
        tenantId:    TENANT_ID,
        id,
        environment,
        status,
        description: `Database ${name}`,
        createdAt,
      }
    )

    const rec        = result.records[0]
    const ciId       = rec.get('id') as string
    const wasCreated = rec.get('wasCreated') as boolean

    if (wasCreated) { created++ } else { skipped++ }

    // OWNED_BY
    await session.run(
      `MATCH (c:ConfigurationItem {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:OWNED_BY]->(t)`,
      { ciId, teamId: ownerTeamId }
    )

    // SUPPORTED_BY
    await session.run(
      `MATCH (c:ConfigurationItem {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:SUPPORTED_BY]->(t)`,
      { ciId, teamId: supportTeamId }
    )

    // DEPENDS_ON servers
    for (const serverId of depServerIds) {
      await session.run(
        `MATCH (c:ConfigurationItem {id: $ciId}), (s:ConfigurationItem {id: $serverId})
         MERGE (c)-[:DEPENDS_ON]->(s)`,
        { ciId, serverId }
      )
    }

    if (i % 40 === 0) console.log(`  ${i}/400 processed...`)
  }

  await session.close()

  console.log(`\nDone. Created: ${created}, Skipped (already existed): ${skipped}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
