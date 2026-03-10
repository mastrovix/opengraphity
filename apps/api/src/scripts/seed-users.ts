import { getSession } from '@opengraphity/neo4j'

const TENANT = 'tenant-demo'
const now    = new Date().toISOString()

const USERS_WITH_TEAMS = [
  { id: 'user-001', name: 'Admin Demo',      email: 'admin@demo.opengraphity.io',          role: 'admin',    team: 'IT Operations' },
  { id: 'user-002', name: 'Marco Rossi',     email: 'marco.rossi@demo.opengraphity.io',    role: 'operator', team: 'IT Operations' },
  { id: 'user-003', name: 'Laura Bianchi',   email: 'laura.bianchi@demo.opengraphity.io',  role: 'operator', team: 'IT Operations' },
  { id: 'user-004', name: 'Luca Esposito',   email: 'luca.esposito@demo.opengraphity.io',  role: 'operator', team: 'Platform Engineering' },
  { id: 'user-005', name: 'Sara Conti',      email: 'sara.conti@demo.opengraphity.io',     role: 'operator', team: 'Platform Engineering' },
  { id: 'user-006', name: 'Paolo Ferrari',   email: 'paolo.ferrari@demo.opengraphity.io',  role: 'operator', team: 'Database Admins' },
  { id: 'user-007', name: 'Anna Greco',      email: 'anna.greco@demo.opengraphity.io',     role: 'operator', team: 'Database Admins' },
  { id: 'user-008', name: 'Roberto Mancini', email: 'roberto.mancini@demo.opengraphity.io',role: 'operator', team: 'Network Team' },
  { id: 'user-009', name: 'Chiara Ricci',    email: 'chiara.ricci@demo.opengraphity.io',   role: 'operator', team: 'Security' },
  { id: 'user-010', name: 'Viewer Demo',     email: 'viewer@demo.opengraphity.io',          role: 'viewer',   team: 'IT Operations' },
]

const session = getSession(undefined, 'WRITE')
try {
  const teamResult = await session.run(
    'MATCH (t:Team {tenant_id: $tenantId}) RETURN t.id AS id, t.name AS name',
    { tenantId: TENANT },
  )
  const teamMap: Record<string, string> = {}
  teamResult.records.forEach((r) => { teamMap[r.get('name') as string] = r.get('id') as string })
  console.log('Team trovati:', Object.keys(teamMap).join(', '))

  for (const u of USERS_WITH_TEAMS) {
    const teamId = teamMap[u.team]
    if (!teamId) { console.warn(`Team non trovato: ${u.team}`); continue }

    await session.executeWrite((tx) => tx.run(`
      MERGE (u:User {id: $id, tenant_id: $tenantId})
      SET u.name       = $name,
          u.email      = $email,
          u.role       = $role,
          u.created_at = $now,
          u.updated_at = $now
      WITH u
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      MERGE (u)-[:MEMBER_OF]->(t)
    `, { ...u, teamId, tenantId: TENANT, now }))
    console.log(`✓ ${u.name} (${u.role}) → ${u.team}`)
  }

  console.log(`\nSeed completato — ${USERS_WITH_TEAMS.length} utenti creati e associati ai team`)
} finally {
  await session.close()
}
