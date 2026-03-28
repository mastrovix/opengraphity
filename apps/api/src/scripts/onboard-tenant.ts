/**
 * Tenant onboarding script — creates a new tenant from scratch.
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/onboard-tenant.ts \
 *     --slug acme \
 *     --admin-email mario@acme.com \
 *     --admin-password Acme1234 \
 *     --admin-first-name Mario \
 *     --admin-last-name Rossi \
 *     [--domain opengrafo.com]
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
    'slug':             { type: 'string' },
    'admin-email':      { type: 'string' },
    'admin-password':   { type: 'string' },
    'admin-first-name': { type: 'string' },
    'admin-last-name':  { type: 'string' },
    'domain':           { type: 'string', default: 'opengrafo.com' },
  },
})

const slug      = args['slug']
const email     = args['admin-email']
const password  = args['admin-password']
const firstName = args['admin-first-name']
const lastName  = args['admin-last-name']
const domain    = args['domain']!

if (!slug || !email || !password || !firstName || !lastName) {
  console.error('Missing required args: --slug --admin-email --admin-password --admin-first-name --admin-last-name')
  process.exit(1)
}

// ── Keycloak helpers ──────────────────────────────────────────────────────────

const KEYCLOAK_URL        = process.env['KEYCLOAK_URL']            ?? 'http://localhost:8080'
const KEYCLOAK_ADMIN_USER = process.env['KEYCLOAK_ADMIN_USER']     ?? 'admin'
const KEYCLOAK_ADMIN_PASS = process.env['KEYCLOAK_ADMIN_PASSWORD'] ?? 'opengrafo_local'

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
  if (!res.ok) throw new Error(`Admin token failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { access_token: string }
  return data.access_token
}

async function kcPost(token: string, path: string, body: unknown): Promise<{ id?: string }> {
  const res = await fetch(`${KEYCLOAK_URL}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`POST ${path} → ${res.status}: ${text}`)
  }
  // 201 Created: id in Location header
  const location = res.headers.get('location')
  const id = location ? location.split('/').pop() : undefined
  return { id }
}

async function kcGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${KEYCLOAK_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
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
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`)
}

// ── Step 1: Create realm ──────────────────────────────────────────────────────

async function createRealm(token: string): Promise<void> {
  await kcPost(token, '/admin/realms', {
    realm:       slug,
    enabled:     true,
    sslRequired: 'none',
    displayName: slug,
  })
  console.log(`  ✓ Realm "${slug}" creato`)
}

// ── Step 2: Create client ─────────────────────────────────────────────────────

async function createClient(token: string): Promise<string> {
  const { id } = await kcPost(token, `/admin/realms/${slug}/clients`, {
    clientId:     'opengrafo-web',
    publicClient: true,
    enabled:      true,
    redirectUris: [
      `https://${slug}.${domain}/*`,
      `http://${slug}.localhost:5173/*`,
    ],
    webOrigins: [
      `https://${slug}.${domain}`,
      `http://${slug}.localhost:5173`,
    ],
  })
  if (!id) throw new Error('Client created but no ID returned')
  console.log(`  ✓ Client "opengrafo-web" creato (id: ${id})`)
  return id
}

// ── Step 3: Create roles ──────────────────────────────────────────────────────

async function createRoles(token: string): Promise<void> {
  for (const name of ['admin', 'user', 'manager']) {
    await kcPost(token, `/admin/realms/${slug}/roles`, { name })
  }
  console.log(`  ✓ Ruoli creati: admin, user, manager`)
}

// ── Step 4: Add realm role mapper to client ───────────────────────────────────

async function addRoleMapper(token: string, clientId: string): Promise<void> {
  await kcPost(token, `/admin/realms/${slug}/clients/${clientId}/protocol-mappers/models`, {
    name:            'realm roles',
    protocol:        'openid-connect',
    protocolMapper:  'oidc-usermodel-realm-role-mapper',
    consentRequired: false,
    config: {
      'multivalued':         'true',
      'userinfo.token.claim': 'true',
      'id.token.claim':       'true',
      'access.token.claim':   'true',
      'claim.name':           'realm_access.roles',
      'jsonType.label':       'String',
    },
  })
  console.log(`  ✓ Mapper "realm roles" aggiunto al client`)
}

// ── Step 5: Create admin user ─────────────────────────────────────────────────

async function createAdminUser(token: string): Promise<void> {
  // Create user
  const { id: userId } = await kcPost(token, `/admin/realms/${slug}/users`, {
    username:      email,
    email,
    emailVerified: true,
    enabled:       true,
    firstName,
    lastName,
  })
  if (!userId) throw new Error('User created but no ID returned')

  // Set password
  await kcPut(token, `/admin/realms/${slug}/users/${userId}/reset-password`, {
    type:      'password',
    value:     password,
    temporary: false,
  })

  // Get admin role representation
  const roles = await kcGet<{ id: string; name: string }[]>(
    token,
    `/admin/realms/${slug}/roles`,
  )
  const adminRole = roles.find((r) => r.name === 'admin')
  if (!adminRole) throw new Error('Role "admin" not found after creation')

  // Assign admin role
  await kcPost(token, `/admin/realms/${slug}/users/${userId}/role-mappings/realm`, [
    { id: adminRole.id, name: adminRole.name },
  ])

  console.log(`  ✓ Utente admin creato: ${email} (id: ${userId})`)
}

// ── Step 6: Neo4j ─────────────────────────────────────────────────────────────

async function provisionNeo4j(): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  const now     = new Date().toISOString()

  try {
    // 6a. Admin User node
    const userId = uuidv4()
    await session.executeWrite((tx) =>
      tx.run(
        `MERGE (u:User {email: $email, tenant_id: $tenantId})
         ON CREATE SET
           u.id         = $id,
           u.name       = $name,
           u.role       = 'admin',
           u.active     = true,
           u.created_at = $now,
           u.updated_at = $now`,
        {
          email,
          tenantId: slug,
          id:       userId,
          name:     `${firstName} ${lastName}`,
          now,
        },
      ),
    )
    console.log(`  ✓ User Neo4j creato: ${email} (tenant_id: ${slug})`)

    // 6b. Default DashboardConfig
    const dashId = uuidv4()
    await session.executeWrite((tx) =>
      tx.run(
        `MERGE (d:DashboardConfig {tenant_id: $tenantId, name: 'Dashboard', is_default: true})
         ON CREATE SET
           d.id         = $id,
           d.user_id    = $userId,
           d.visibility = 'private',
           d.created_at = $now,
           d.updated_at = $now`,
        { tenantId: slug, id: dashId, userId, now },
      ),
    )
    console.log(`  ✓ DashboardConfig default creato`)

    // 6c. Verify base CITypeDefinitions are accessible (scope='base' nodes are shared)
    const ciResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (t:CITypeDefinition)
         WHERE t.scope = 'base' AND t.active = true
         RETURN count(t) AS total`,
      ),
    )
    const ciCount = (ciResult.records[0]?.get('total') as { toNumber(): number })?.toNumber() ?? 0
    if (ciCount === 0) {
      console.warn(`  ⚠ Nessun CITypeDefinition con scope='base' trovato — esegui seed-metamodel.ts`)
    } else {
      console.log(`  ✓ ${ciCount} CITypeDefinition base disponibili per il tenant`)
    }
  } finally {
    await session.close()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  OpenGrafo — Onboarding tenant: ${slug.padEnd(8)} ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  // ── Keycloak ────────────────────────────────────────
  console.log('▶ Keycloak')
  const token    = await getAdminToken()
  await createRealm(token)
  const clientId = await createClient(token)
  await createRoles(token)
  await addRoleMapper(token, clientId)
  await createAdminUser(token)

  // ── Neo4j ───────────────────────────────────────────
  console.log('\n▶ Neo4j')
  await provisionNeo4j()

  // ── Summary ─────────────────────────────────────────
  console.log(`
╔══════════════════════════════════════════════════════╗
║  Tenant "${slug}" creato con successo!
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
