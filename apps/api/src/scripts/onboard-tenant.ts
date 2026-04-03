/**
 * Tenant onboarding script — creates a new tenant from scratch.
 * Idempotent: safe to run multiple times, skips existing resources.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/onboard-tenant.ts \
 *     --slug acme \
 *     --admin-email mario@acme.com \
 *     --admin-password Acme1234 \
 *     --admin-first-name Mario \
 *     --admin-last-name Rossi \
 *     [--domain opengrafo.com]
 *     [--pi-ip 192.168.1.119]
 *
 * Required env vars:
 *   KEYCLOAK_URL, KEYCLOAK_ADMIN_USER (default "admin"), KEYCLOAK_ADMIN_PASSWORD
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import { v4 as uuidv4 } from 'uuid'
import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'
import { seedNotificationRules } from '../lib/seedNotificationRules.js'
import { seedSystemEnumTypes } from '../lib/seedEnumTypes.js'

// ── Args ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'slug':             { type: 'string' },
    'admin-email':      { type: 'string' },
    'admin-password':   { type: 'string' },
    'admin-first-name': { type: 'string' },
    'admin-last-name':  { type: 'string' },
    'domain':           { type: 'string', default: 'opengrafo.com' },
    'admin-role':       { type: 'string', default: 'admin' },
    'pi-ip':            { type: 'string' },
  },
})

const slug      = args['slug']
const email     = args['admin-email']
const password  = args['admin-password']
const firstName = args['admin-first-name']
const lastName  = args['admin-last-name']
const domain    = args['domain']!
const adminRole = args['admin-role']!
const piIp      = args['pi-ip']

const ALLOWED_ROLES = ['admin', 'user', 'manager'] as const
if (!ALLOWED_ROLES.includes(adminRole as typeof ALLOWED_ROLES[number])) {
  console.error(`Errore: --admin-role deve essere uno di: ${ALLOWED_ROLES.join(', ')}`)
  process.exit(1)
}

if (!slug || !email || !password || !firstName || !lastName) {
  console.error('Errore: argomenti mancanti.')
  console.error('Uso: --slug <slug> --admin-email <email> --admin-password <pwd> --admin-first-name <nome> --admin-last-name <cognome>')
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

/** Returns the resource id from the Location header, or undefined. */
function idFromLocation(res: Response): string | undefined {
  return res.headers.get('location')?.split('/').pop()
}

async function kcGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${KEYCLOAK_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

/**
 * POST to Keycloak Admin API.
 * Returns { id, created: true } on 201, { id, created: false } on 409 (already exists).
 * Throws on any other error status.
 */
async function kcPost(
  token: string,
  path: string,
  body: unknown,
): Promise<{ id?: string; created: boolean }> {
  const res = await fetch(`${KEYCLOAK_URL}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  if (res.status === 409) {
    return { created: false }
  }
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`)
  }
  return { id: idFromLocation(res), created: true }
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

// ── Step 1: Realm ─────────────────────────────────────────────────────────────

async function createRealm(token: string): Promise<void> {
  const { created } = await kcPost(token, '/admin/realms', {
    realm:       slug,
    enabled:     true,
    sslRequired: 'none',
    displayName: slug,
  })
  if (created) {
    console.log(`  ✓ Realm "${slug}" creato`)
  } else {
    console.log(`  ↩ Realm "${slug}" già esistente — skip`)
  }
}

// ── Step 2: Client ────────────────────────────────────────────────────────────

async function createClient(token: string): Promise<string> {
  const { id, created } = await kcPost(token, `/admin/realms/${slug}/clients`, {
    clientId:     'opengrafo-web',
    publicClient: true,
    enabled:      true,
    redirectUris: [
      `https://${slug}.${domain}/*`,
      `http://${slug}.localhost:5173/*`,
      ...(piIp ? [`https://${slug}.${piIp}.nip.io/*`] : []),
    ],
    webOrigins: [
      `https://${slug}.${domain}`,
      `http://${slug}.localhost:5173`,
      ...(piIp ? [`https://${slug}.${piIp}.nip.io`] : []),
    ],
  })

  if (created && id) {
    console.log(`  ✓ Client "opengrafo-web" creato (id: ${id})`)
    return id
  }

  // Already exists — retrieve the id via GET
  const clients = await kcGet<{ id: string; clientId: string }[]>(
    token,
    `/admin/realms/${slug}/clients?clientId=opengrafo-web`,
  )
  const existing = clients[0]
  if (!existing) {
    throw new Error('Client "opengrafo-web" non trovato dopo 409 — stato inatteso')
  }
  console.log(`  ↩ Client "opengrafo-web" già esistente (id: ${existing.id}) — skip`)
  return existing.id
}

// ── Step 3: Roles ─────────────────────────────────────────────────────────────

async function createRoles(token: string): Promise<void> {
  let created = 0
  for (const name of ['admin', 'user', 'manager']) {
    const { created: wasCreated } = await kcPost(token, `/admin/realms/${slug}/roles`, { name })
    if (wasCreated) created++
  }
  if (created === 3) {
    console.log(`  ✓ Ruoli creati: admin, user, manager`)
  } else {
    console.log(`  ↩ Ruoli già esistenti (${3 - created} skippati)`)
  }
}

// ── Step 4: Realm role mapper ─────────────────────────────────────────────────

async function addRoleMapper(token: string, clientId: string): Promise<void> {
  const { created } = await kcPost(
    token,
    `/admin/realms/${slug}/clients/${clientId}/protocol-mappers/models`,
    {
      name:            'realm roles',
      protocol:        'openid-connect',
      protocolMapper:  'oidc-usermodel-realm-role-mapper',
      consentRequired: false,
      config: {
        'multivalued':          'true',
        'userinfo.token.claim': 'true',
        'id.token.claim':       'true',
        'access.token.claim':   'true',
        'claim.name':           'realm_access.roles',
        'jsonType.label':       'String',
      },
    },
  )
  if (created) {
    console.log(`  ✓ Mapper "realm roles" aggiunto al client`)
  } else {
    console.log(`  ↩ Mapper "realm roles" già esistente — skip`)
  }
}

// ── Step 5: Admin user ────────────────────────────────────────────────────────

async function createAdminUser(token: string): Promise<void> {
  const { id: newId, created } = await kcPost(token, `/admin/realms/${slug}/users`, {
    username:      email,
    email,
    emailVerified: true,
    enabled:       true,
    firstName,
    lastName,
  })

  let userId: string

  if (created && newId) {
    userId = newId!
  } else {
    // Already exists — retrieve user id
    const users = await kcGet<{ id: string }[]>(
      token,
      `/admin/realms/${slug}/users?email=${encodeURIComponent(email!)}&exact=true`,
    )
    const existing = users[0]
    if (!existing) {
      throw new Error(`Utente "${email}" non trovato dopo 409 — stato inatteso`)
    }
    userId = existing.id
    console.log(`  ↩ Utente "${email}" già esistente — skip creazione`)
  }

  if (created) {
    // Set password only for newly created users
    await kcPut(token, `/admin/realms/${slug}/users/${userId}/reset-password`, {
      type:      'password',
      value:     password,
      temporary: false,
    })
  }

  // Assign role (idempotent — Keycloak ignores duplicate role assignments)
  const roles = await kcGet<{ id: string; name: string }[]>(
    token,
    `/admin/realms/${slug}/roles`,
  )
  const roleToAssign = roles.find((r) => r.name === adminRole)
  if (!roleToAssign) {
    throw new Error(`Ruolo "${adminRole}" non trovato nel realm — esegui prima createRoles()`)
  }
  await kcPost(token, `/admin/realms/${slug}/users/${userId}/role-mappings/realm`, [
    { id: roleToAssign.id, name: roleToAssign.name },
  ])

  if (created) {
    console.log(`  ✓ Utente admin creato: ${email} (id: ${userId})`)
  }
}

// ── Step 6: Neo4j ─────────────────────────────────────────────────────────────

async function provisionNeo4j(): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  const now     = new Date().toISOString()

  try {
    // 6a. Admin User node — MERGE is inherently idempotent
    const userId = uuidv4()
    const userResult = await session.executeWrite((tx) =>
      tx.run(
        `MERGE (u:User {email: $email, tenant_id: $tenantId})
         ON CREATE SET
           u.id         = $id,
           u.name       = $name,
           u.role       = $role,
           u.active     = true,
           u.created_at = $now,
           u.updated_at = $now
         RETURN (u.created_at = $now) AS wasCreated`,
        { email, tenantId: slug, id: userId, name: `${firstName} ${lastName}`, role: adminRole, now },
      ),
    )
    const userCreated = userResult.records[0]?.get('wasCreated') as boolean
    if (userCreated) {
      console.log(`  ✓ User Neo4j creato: ${email} (tenant_id: ${slug})`)
    } else {
      console.log(`  ↩ User Neo4j già esistente: ${email} — skip`)
    }

    // 6b. Default DashboardConfig — MERGE is idempotent
    const dashId = uuidv4()
    const dashResult = await session.executeWrite((tx) =>
      tx.run(
        `MERGE (d:DashboardConfig {tenant_id: $tenantId, name: 'Dashboard', is_default: true})
         ON CREATE SET
           d.id         = $id,
           d.user_id    = $userId,
           d.visibility = 'private',
           d.created_at = $now,
           d.updated_at = $now
         RETURN (d.created_at = $now) AS wasCreated`,
        { tenantId: slug, id: dashId, userId, now },
      ),
    )
    const dashCreated = dashResult.records[0]?.get('wasCreated') as boolean
    if (dashCreated) {
      console.log(`  ✓ DashboardConfig default creato`)
    } else {
      console.log(`  ↩ DashboardConfig già esistente — skip`)
    }

    // 6c. Notification rules default
    await seedNotificationRules(slug!, session)

    // 6d. Seed system enum types
    await seedSystemEnumTypes(slug!, session)
    console.log(`  ✓ System enum types seeded`)

    // 6f. Verify base CITypeDefinitions (shared, scope='base')
    const ciResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (t:CITypeDefinition)
         WHERE t.scope = 'base' AND t.active = true
         RETURN count(t) AS total`,
      ),
    )
    const ciCount = (ciResult.records[0]?.get('total') as { toNumber(): number })?.toNumber() ?? 0
    if (ciCount === 0) {
      console.warn(`  ⚠ Nessun CITypeDefinition scope='base' trovato — esegui seed-metamodel.ts`)
    } else {
      console.log(`  ✓ ${ciCount} CITypeDefinition base disponibili`)
    }

    // 6g. Verify ITIL CITypeDefinitions (shared, scope='itil')
    const itilResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (t:CITypeDefinition)
         WHERE t.scope = 'itil' AND t.active = true
         RETURN count(t) AS total`,
      ),
    )
    const itilCount = (itilResult.records[0]?.get('total') as { toNumber(): number })?.toNumber() ?? 0
    if (itilCount === 0) {
      console.warn(`  ⚠ Nessun CITypeDefinition scope='itil' trovato — esegui seed-itil-metamodel.ts`)
    } else {
      console.log(`  ✓ ${itilCount} CITypeDefinition ITIL disponibili`)
    }
  } finally {
    await session.close()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  OpenGrafo — Onboarding tenant: ${slug!.padEnd(8)} ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  console.log('▶ Keycloak')
  const token    = await getAdminToken()
  await createRealm(token)
  const clientId = await createClient(token)
  await createRoles(token)
  await addRoleMapper(token, clientId)
  await createAdminUser(token)

  console.log('\n▶ Neo4j')
  await provisionNeo4j()

  console.log(`
╔══════════════════════════════════════════════════════╗
║  Tenant "${slug}" pronto!
╠══════════════════════════════════════════════════════╣
║  URL locale:     http://${slug}.localhost:5173
║  URL produzione: https://${slug}.${domain}
║
║  Keycloak realm: ${slug}
║  Admin login:    ${email}
║  Password:       ${password}
╚══════════════════════════════════════════════════════╝
`)
}

main().catch((err: unknown) => {
  console.error('\n✖ Onboarding fallito:', err instanceof Error ? err.message : err)
  process.exit(1)
})
