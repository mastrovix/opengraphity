import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
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
  if (teamIds.length === 0) throw new Error('No teams found for c-one')

  // Load SRV-xxx servers only
  const serversResult = await session.run(
    `MATCH (c:Server {tenant_id: $tenantId})
     WHERE c.name STARTS WITH 'SRV-'
     RETURN c.id AS id`,
    { tenantId: TENANT_ID }
  )
  const serverIds = serversResult.records.map((r) => r.get('id') as string)
  if (serverIds.length === 0) throw new Error('No SRV-xxx servers found for c-one')

  let created = 0
  let skipped = 0

  for (let i = 1; i <= 100; i++) {
    const name          = `DBINST-${String(i).padStart(3, '0')}`
    const id            = uuidv4()
    const environment   = pickEnvironment()
    const status        = pickStatus()
    const createdAt     = randomDateInPast2Years()
    const ownerTeamId   = pick(teamIds)
    const supportTeamId = pick(teamIds)
    const serverId      = pick(serverIds)

    const result = await session.run(
      `MERGE (c:DatabaseInstance {name: $name, tenant_id: $tenantId})
       ON CREATE SET
         c.id          = $id,
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
        description: `Database Instance ${name}`,
        createdAt,
      }
    )

    const rec        = result.records[0]
    const ciId       = rec.get('id') as string
    const wasCreated = rec.get('wasCreated') as boolean

    if (wasCreated) { created++ } else { skipped++ }

    await session.run(
      `MATCH (c:DatabaseInstance {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:OWNED_BY]->(t)`,
      { ciId, teamId: ownerTeamId }
    )

    await session.run(
      `MATCH (c:DatabaseInstance {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:SUPPORTED_BY]->(t)`,
      { ciId, teamId: supportTeamId }
    )

    await session.run(
      `MATCH (c:DatabaseInstance {id: $ciId}), (s:Server {id: $serverId})
       MERGE (c)-[:HOSTED_ON]->(s)`,
      { ciId, serverId }
    )

    if (i % 20 === 0) console.log(`  ${i}/100 processed...`)
  }

  await session.close()
  console.log(`\nDone. Created: ${created}, Skipped (already existed): ${skipped}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
