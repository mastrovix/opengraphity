import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'tenant-demo'

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

  // Load owner teams
  const ownerResult = await session.run(
    `MATCH (t:Team {tenant_id: $tenantId, type: 'owner'}) RETURN t.id AS id, t.name AS name`,
    { tenantId: TENANT_ID }
  )
  const ownerTeams = ownerResult.records.map((r) => ({ id: r.get('id') as string, name: r.get('name') as string }))
  if (ownerTeams.length === 0) throw new Error('No owner teams found')

  // Load support teams
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

  // Track distribution
  const ownerCount: Record<string, number> = {}
  const supportCount: Record<string, number> = {}

  for (let i = 1; i <= 300; i++) {
    const name        = `APP-${String(i).padStart(3, '0')}`
    const id          = uuidv4()
    const environment = pickEnvironment()
    const status      = pickStatus()

    // Round-robin with jitter for uniform distribution
    const ownerTeam   = ownerTeams[i % ownerTeams.length]
    const supportTeam = supportTeams[i % supportTeams.length]

    const result = await session.run(
      `MERGE (c:ConfigurationItem {name: $name, tenant_id: $tenantId})
       ON CREATE SET
         c.id          = $id,
         c.type        = 'application',
         c.environment = $environment,
         c.status      = $status,
         c.description = $description,
         c.tenant_id   = $tenantId,
         c.created_at  = $createdAt,
         c.updated_at  = $createdAt
       RETURN c.id AS id, (c.created_at = $createdAt) AS wasCreated`,
      { name, tenantId: TENANT_ID, id, environment, status, description: `Application ${name}`, createdAt: now }
    )

    const rec        = result.records[0]
    const ciId       = rec.get('id') as string
    const wasCreated = rec.get('wasCreated') as boolean
    if (wasCreated) { created++ } else { skipped++ }

    await session.run(
      `MATCH (c:ConfigurationItem {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:OWNED_BY]->(t)`,
      { ciId, teamId: ownerTeam.id }
    )
    await session.run(
      `MATCH (c:ConfigurationItem {id: $ciId}), (t:Team {id: $teamId})
       MERGE (c)-[:SUPPORTED_BY]->(t)`,
      { ciId, teamId: supportTeam.id }
    )

    ownerCount[ownerTeam.name]   = (ownerCount[ownerTeam.name]   ?? 0) + 1
    supportCount[supportTeam.name] = (supportCount[supportTeam.name] ?? 0) + 1

    if (i % 60 === 0) console.log(`  ${i}/300 processed...`)
  }

  await session.close()

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`)

  const ownerEntries   = Object.entries(ownerCount).sort((a, b) => b[1] - a[1])
  const supportEntries = Object.entries(supportCount).sort((a, b) => b[1] - a[1])
  console.log(`\nOwner team distribution (top 5):`)
  ownerEntries.slice(0, 5).forEach(([name, n]) => console.log(`  ${name}: ${n}`))
  console.log(`\nSupport team distribution (top 5):`)
  supportEntries.slice(0, 5).forEach(([name, n]) => console.log(`  ${name}: ${n}`))
  console.log(`\nOwner teams used: ${ownerEntries.length}/${ownerTeams.length}`)
  console.log(`Support teams used: ${supportEntries.length}/${supportTeams.length}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
