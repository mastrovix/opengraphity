/**
 * Add a user to an existing tenant.
 * Idempotent: if the user already exists in Keycloak, updates role and password.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/add-user.ts \
 *     --slug c-one \
 *     --email mario@acme.com \
 *     --password Acme1234 \
 *     --first-name Mario \
 *     --last-name Rossi \
 *     [--role user]
 *
 * Required env vars:
 *   KEYCLOAK_URL, KEYCLOAK_ADMIN_USER (default "admin"), KEYCLOAK_ADMIN_PASSWORD
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import { v4 as uuidv4 } from 'uuid'
import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'

// ── Args ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'slug':       { type: 'string' },
    'email':      { type: 'string' },
    'password':   { type: 'string' },
    'first-name': { type: 'string' },
    'last-name':  { type: 'string' },
    'role':       { type: 'string', default: 'user' },
  },
})

const slug      = args['slug']
const email     = args['email']
const password  = args['password']
const firstName = args['first-name']
const lastName  = args['last-name']
const role      = args['role']!

const ALLOWED_ROLES = ['admin', 'user', 'manager'] as const
if (!ALLOWED_ROLES.includes(role as typeof ALLOWED_ROLES[number])) {
  console.error(`Errore: --role deve essere uno di: ${ALLOWED_ROLES.join(', ')}`)
  process.exit(1)
}

if (!slug || !email || !password || !firstName || !lastName) {
  console.error('Errore: argomenti mancanti.')
  console.error('Uso: --slug <slug> --email <email> --password <pwd> --first-name <nome> --last-name <cognome> [--role user]')
  process.exit(1)
}

// ── Keycloak config ───────────────────────────────────────────────────────────

const KEYCLOAK_URL        = process.env['KEYCLOAK_URL']            ?? 'http://localhost:8080'
const KEYCLOAK_ADMIN_USER = process.env['KEYCLOAK_ADMIN_USER']     ?? 'admin'
const KEYCLOAK_ADMIN_PASS = process.env['KEYCLOAK_ADMIN_PASSWORD'] ?? 'opengrafo_local'

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function getAdminToken(): Promise<string> {
  const res = await fetch(
    `${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type: 'password',
        client_id:  'admin-cli',
        username:   KEYCLOAK_ADMIN_USER,
        password:   KEYCLOAK_ADMIN_PASS,
      }),
    },
  )
  if (!res.ok) {
    throw new Error(`Keycloak auth fallita (${res.status}): verifica KEYCLOAK_URL e credenziali admin`)
  }
  const data = await res.json() as { access_token: string }
  return data.access_token
}

async function kcGet<T>(token: string, path: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${KEYCLOAK_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`)
  }
  const data = res.ok ? await res.json() as T : ([] as unknown as T)
  return { status: res.status, data }
}

async function kcPost(
  token: string,
  path: string,
  body: unknown,
): Promise<{ status: number; id?: string }> {
  const res = await fetch(`${KEYCLOAK_URL}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (res.status !== 201 && res.status !== 204 && res.status !== 409) {
    throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`)
  }
  const id = res.headers.get('location')?.split('/').pop()
  return { status: res.status, id }
}

async function kcPut(token: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${KEYCLOAK_URL}${path}`, {
    method:  'PUT',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`)
  }
}

// ── Step 1: Verify realm exists ───────────────────────────────────────────────

async function verifyRealm(token: string): Promise<void> {
  const { status } = await kcGet<unknown>(token, `/admin/realms/${slug}`)
  if (status === 404) {
    throw new Error(
      `Realm "${slug}" non trovato in Keycloak. ` +
      `Crea prima il tenant con onboard-tenant.ts.`,
    )
  }
  console.log(`  ✓ Realm "${slug}" verificato`)
}

// ── Step 2+3+4: Create/update user in Keycloak ────────────────────────────────

async function upsertKeycloakUser(token: string): Promise<void> {
  // Try to create
  const { status, id: newId } = await kcPost(token, `/admin/realms/${slug}/users`, {
    username:      email,
    email,
    emailVerified: true,
    enabled:       true,
    firstName,
    lastName,
  })

  let userId: string
  let wasCreated: boolean

  if (status === 201 && newId) {
    userId     = newId
    wasCreated = true
  } else {
    // 409 — already exists, retrieve id
    const { data: users } = await kcGet<{ id: string }[]>(
      token,
      `/admin/realms/${slug}/users?email=${encodeURIComponent(email)}&exact=true`,
    )
    const existing = users[0]
    if (!existing) {
      throw new Error(`Utente "${email}" non trovato dopo 409 — stato inatteso`)
    }
    userId     = existing.id
    wasCreated = false
    console.log(`  ↩ Utente già esistente in Keycloak — aggiorno password e ruolo`)
  }

  // Set/reset password
  await kcPut(token, `/admin/realms/${slug}/users/${userId}/reset-password`, {
    type:      'password',
    value:     password,
    temporary: false,
  })

  // Assign role (idempotent)
  const { data: roles } = await kcGet<{ id: string; name: string }[]>(
    token,
    `/admin/realms/${slug}/roles`,
  )
  const targetRole = roles.find((r) => r.name === role)
  if (!targetRole) {
    throw new Error(
      `Ruolo "${role}" non trovato nel realm "${slug}". ` +
      `Verifica che i ruoli siano stati creati con onboard-tenant.ts.`,
    )
  }
  await kcPost(token, `/admin/realms/${slug}/users/${userId}/role-mappings/realm`, [
    { id: targetRole.id, name: targetRole.name },
  ])

  if (wasCreated) {
    console.log(`  ✓ Utente creato in Keycloak: ${email} (id: ${userId})`)
  }
  console.log(`  ✓ Password impostata, ruolo "${role}" assegnato`)
}

// ── Step 5: Neo4j ─────────────────────────────────────────────────────────────

async function upsertNeo4jUser(): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  const now     = new Date().toISOString()

  try {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MERGE (u:User {email: $email, tenant_id: $tenantId})
         ON CREATE SET
           u.id         = $id,
           u.name       = $name,
           u.role       = $role,
           u.active     = true,
           u.created_at = $now,
           u.updated_at = $now
         ON MATCH SET
           u.name       = $name,
           u.role       = $role,
           u.updated_at = $now
         RETURN (u.created_at = $now) AS wasCreated`,
        {
          email,
          tenantId: slug,
          id:       uuidv4(),
          name:     `${firstName} ${lastName}`,
          role,
          now,
        },
      ),
    )

    const wasCreated = result.records[0]?.get('wasCreated') as boolean
    if (wasCreated) {
      console.log(`  ✓ User Neo4j creato: ${email} (tenant_id: ${slug}, role: ${role})`)
    } else {
      console.log(`  ↩ User Neo4j aggiornato: ${email} (role: ${role})`)
    }
  } finally {
    await session.close()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  OpenGrafo — Add user to tenant: ${slug!.padEnd(7)} ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  console.log('▶ Keycloak')
  const token = await getAdminToken()
  await verifyRealm(token)
  await upsertKeycloakUser(token)

  console.log('\n▶ Neo4j')
  await upsertNeo4jUser()

  console.log(`
╔══════════════════════════════════════════════╗
║  Utente aggiunto con successo!
╠══════════════════════════════════════════════╣
║  Tenant:  ${slug}
║  Email:   ${email}
║  Nome:    ${firstName} ${lastName}
║  Ruolo:   ${role}
╚══════════════════════════════════════════════╝
`)
}

main().catch((err: unknown) => {
  console.error('\n✖ Operazione fallita:', err instanceof Error ? err.message : err)
  process.exit(1)
})
