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
  if (r < 0.70) return 'active'
  if (r < 0.90) return 'expired'
  return 'revoked'
}

function pickCertType(): string {
  return Math.random() < 0.60 ? 'public' : 'external'
}

function randomExpiresAt(): string {
  const minDays = 30
  const maxDays = 3 * 365
  const days = minDays + Math.floor(Math.random() * (maxDays - minDays))
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function pickSubset<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length))
}

async function seed() {
  const session = getSession(undefined, neo4j.session.WRITE)

  const ownerResult = await session.run(
    `MATCH (t:Team {tenant_id: $tenantId, type: 'owner'}) RETURN t.id AS id`,
    { tenantId: TENANT_ID }
  )
  const ownerTeams = ownerResult.records.map(r => r.get('id') as string)
  if (!ownerTeams.length) throw new Error('No owner teams found')

  const supportResult = await session.run(
    `MATCH (t:Team {tenant_id: $tenantId, type: 'support'}) RETURN t.id AS id`,
    { tenantId: TENANT_ID }
  )
  const supportTeams = supportResult.records.map(r => r.get('id') as string)

  const serverResult = await session.run(
    `MATCH (c:ConfigurationItem {tenant_id: $tenantId, type: 'server'}) RETURN c.id AS id`,
    { tenantId: TENANT_ID }
  )
  const servers = serverResult.records.map(r => r.get('id') as string)
  if (!servers.length) throw new Error('No servers found')

  let created = 0
  let skipped = 0
  const now = new Date().toISOString()

  for (let i = 1; i <= 200; i++) {
    const name = `CERT-${String(i).padStart(3, '0')}`
    const id = uuidv4()
    const ownerTeam = ownerTeams[i % ownerTeams.length]
    const supportTeam = supportTeams.length > 0 ? supportTeams[i % supportTeams.length] : ownerTeam

    const result = await session.run(
      `MERGE (c:ConfigurationItem {name: $name, tenant_id: $tenantId})
       ON CREATE SET
         c.id               = $id,
         c.type             = 'certificate',
         c.serial_number    = $serialNumber,
         c.certificate_type = $certType,
         c.expires_at       = $expiresAt,
         c.status           = $status,
         c.environment      = $environment,
         c.description      = $description,
         c.tenant_id        = $tenantId,
         c.created_at       = $createdAt,
         c.updated_at       = $createdAt
       RETURN c.id AS id, (c.created_at = $createdAt) AS wasCreated`,
      {
        name, tenantId: TENANT_ID, id,
        serialNumber: uuidv4(),
        certType: pickCertType(),
        expiresAt: randomExpiresAt(),
        status: pickStatus(),
        environment: pickEnvironment(),
        description: `Certificate ${name}`,
        createdAt: now,
      }
    )

    const rec = result.records[0]
    const ciId = rec.get('id') as string
    const wasCreated = rec.get('wasCreated') as boolean
    if (wasCreated) { created++ } else { skipped++ }

    await session.run(
      `MATCH (c:ConfigurationItem {id: $ciId}), (t:Team {id: $teamId}) MERGE (c)-[:OWNED_BY]->(t)`,
      { ciId, teamId: ownerTeam }
    )
    await session.run(
      `MATCH (c:ConfigurationItem {id: $ciId}), (t:Team {id: $teamId}) MERGE (c)-[:SUPPORTED_BY]->(t)`,
      { ciId, teamId: supportTeam }
    )

    const protectedByCount = Math.random() < 0.5 ? 1 : 2
    const protectedServers = pickSubset(servers, protectedByCount)
    for (const srvId of protectedServers) {
      await session.run(
        `MATCH (c:ConfigurationItem {id: $ciId}), (s:ConfigurationItem {id: $srvId}) MERGE (c)-[:PROTECTED_BY]->(s)`,
        { ciId, srvId }
      )
    }

    if (i % 50 === 0) console.log(`  ${i}/200 processed...`)
  }

  await session.close()
  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`)
}

seed().catch(err => { console.error(err); process.exit(1) })
