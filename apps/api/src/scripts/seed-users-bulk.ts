import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'

function pickRole(): string {
  const rand = Math.random()
  return rand < 0.03 ? 'admin' : rand < 0.13 ? 'viewer' : 'operator'
}

function pickTeamCount(): number {
  const r = Math.random()
  if (r < 0.50) return 1
  if (r < 0.85) return 2
  return 3
}

function pickUnique<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(n, shuffled.length))
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
  console.log(`Loaded ${teamIds.length} teams`)

  let created   = 0
  let skipped   = 0
  let relations = 0
  const now = new Date().toISOString()

  for (let i = 1; i <= 700; i++) {
    const pad   = String(i).padStart(3, '0')
    const name  = `USR-${pad}`
    const email = `usr-${pad}@demo.opengrafo.io`
    const role  = pickRole()
    const id    = uuidv4()

    const result = await session.run(
      `MERGE (u:User {email: $email, tenant_id: $tenantId})
       ON CREATE SET
         u.id         = $id,
         u.name       = $name,
         u.role       = $role,
         u.tenant_id  = $tenantId,
         u.created_at = $createdAt
       RETURN u.id AS id, (u.created_at = $createdAt) AS wasCreated`,
      { email, tenantId: TENANT_ID, id, name, role, createdAt: now }
    )

    const rec        = result.records[0]
    const userId     = rec.get('id') as string
    const wasCreated = rec.get('wasCreated') as boolean
    if (wasCreated) { created++ } else { skipped++ }

    const teamCount    = pickTeamCount()
    const assignedTeams = pickUnique(teamIds, teamCount)

    for (const teamId of assignedTeams) {
      await session.run(
        `MATCH (u:User {id: $userId}), (t:Team {id: $teamId})
         MERGE (u)-[:MEMBER_OF]->(t)`,
        { userId, teamId }
      )
      relations++
    }

    if (i % 100 === 0) console.log(`  ${i}/700 processed...`)
  }

  await session.close()
  console.log(`\nDone.`)
  console.log(`  Utenti creati : ${created}`)
  console.log(`  Già esistenti : ${skipped}`)
  console.log(`  MEMBER_OF     : ${relations}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
