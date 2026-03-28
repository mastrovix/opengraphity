import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'

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

  const ownerResult = await session.run(
    `MATCH (t:Team {tenant_id: $tenantId, type: 'owner'}) RETURN t.id AS id, t.name AS name`,
    { tenantId: TENANT_ID }
  )
  const ownerTeams = ownerResult.records.map((r) => ({ id: r.get('id') as string, name: r.get('name') as string }))
  if (ownerTeams.length === 0) throw new Error('No owner teams found')

  const supportResult = await session.run(
    `MATCH (t:Team {tenant_id: $tenantId, type: 'support'}) RETURN t.id AS id, t.name AS name`,
    { tenantId: TENANT_ID }
  )
  const supportTeams = supportResult.records.map((r) => ({ id: r.get('id') as string, name: r.get('name') as string }))
  if (supportTeams.length === 0) throw new Error('No support teams found')

  console.log(`Owner teams: ${ownerTeams.length}, Support teams: ${supportTeams.length}`)

  let created = 0
  let skipped = 0
  const now = new Date().toISOString()

  for (let i = 1; i <= 300; i++) {
    const name        = `DTI-${String(i).padStart(3, '0')}`
    const id          = uuidv4()
    const environment = pickEnvironment()
    const status      = pickStatus()
    const ownerTeam   = ownerTeams[i % ownerTeams.length]
    const supportTeam = supportTeams[i % supportTeams.length]

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
      { name, tenantId: TENANT_ID, id, environment, status, description: `Database Instance ${name}`, createdAt: now }
    )

    const rec        = result.records[0]
    const ciId       = rec.get('id') as string
    const wasCreated = rec.get('wasCreated') as boolean
    if (wasCreated) { created++ } else { skipped++ }

    await session.run(
      `MATCH (c:DatabaseInstance {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:OWNED_BY]->(t)`,
      { ciId, teamId: ownerTeam.id }
    )
    await session.run(
      `MATCH (c:DatabaseInstance {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:SUPPORTED_BY]->(t)`,
      { ciId, teamId: supportTeam.id }
    )

    if (i % 60 === 0) console.log(`  ${i}/300 processed...`)
  }

  await session.close()
  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
