/**
 * Tenant onboarding script — creates a new tenant from scratch.
 * Idempotent: safe to run multiple times, skips existing resources.
 *
 * Usage:
 *   pnpm --filter @opengraphity/api onboard-tenant -- \
 *     --slug acme \
 *     --admin-email mario@acme.com \
 *     --admin-first-name Mario \
 *     --admin-last-name Rossi \
 *     [--password-stdin]
 *     [--name "ACME S.p.A."]           (default: slug)
 *     [--plan starter|pro|enterprise]  (default: starter)
 *     [--timezone Europe/Rome]         (default: Europe/Rome — must be a valid IANA zone)
 *     [--domain opengrafo.com]
 *     [--pi-ip 192.168.1.119]
 *
 * Password admin (mai in argv — `--admin-password X` è rifiutato):
 *   - `--password-stdin`: letta da stdin → printf '%s' "$PWD" | pnpm … onboard-tenant -- … --password-stdin
 *   - senza flag: generata casualmente, impostata come temporanea in Keycloak
 *     (cambio obbligatorio al primo login) e stampata UNA volta.
 *   La password viene impostata SOLO alla creazione dell'utente admin.
 *
 * Neo4j side: creates the `:Tenant` node (id = slug; anomaly scanner, email
 * digest and seed-field-rules enumerate tenants from it), the admin User,
 * default dashboard/notification rules/enum types and seeds EVERY workflow
 * the tenant needs to be operational: incident (+ security variant),
 * problem, KB article, change RFC and service request.
 *
 * Required env vars:
 *   KEYCLOAK_ADMIN_PASSWORD (nessun default); KEYCLOAK_URL, KEYCLOAK_ADMIN_USER
 *   (default locali solo fuori produzione); NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import { v4 as uuidv4 } from 'uuid'
import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'
import type { Tenant } from '@opengraphity/types'
import { seedNotificationRules } from '../lib/seedNotificationRules.js'
import { seedSystemEnumTypes } from '../lib/seedEnumTypes.js'
import {
  seedKBWorkflowForTenant,
  seedProblemWorkflowForTenant,
  seedWorkflowDefinition,
  seedWorkflowForTenant,
} from '@opengraphity/workflow'
import { CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW } from './lib/workflowDefinitions.js'
import { ScriptArgError } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { assignRealmRole, createKeycloakAdmin, findUserIdByEmail, keycloakConfigFromEnv, type KeycloakAdmin } from './lib/keycloakAdmin.js'
import { PASSWORD_STDIN_FLAG, assertNoPasswordInArgv, printOneTimePassword, resolvePassword, type ResolvedPassword } from './lib/password.js'

// ── Args ──────────────────────────────────────────────────────────────────────

const ALLOWED_ROLES = ['admin', 'user', 'manager'] as const
const ALLOWED_PLANS = ['starter', 'pro', 'enterprise'] as const satisfies readonly Tenant['plan'][]

interface Args {
  slug:       string
  email:      string
  firstName:  string
  lastName:   string
  domain:     string
  adminRole:  typeof ALLOWED_ROLES[number]
  piIp:       string | undefined
  tenantName: string
  plan:       Tenant['plan']
  timezone:   string
}

function parseCliArgs(argv: readonly string[]): Args {
  assertNoPasswordInArgv(argv)

  const { values: args } = parseArgs({
    args: [...argv],
    options: {
      'slug':             { type: 'string' },
      'admin-email':      { type: 'string' },
      'admin-first-name': { type: 'string' },
      'admin-last-name':  { type: 'string' },
      'password-stdin':   { type: 'boolean', default: false },
      'domain':           { type: 'string', default: 'opengrafo.com' },
      'admin-role':       { type: 'string', default: 'admin' },
      'pi-ip':            { type: 'string' },
      'name':             { type: 'string' },
      'plan':             { type: 'string', default: 'starter' },
      'timezone':         { type: 'string', default: 'Europe/Rome' },
    },
  })

  const slug      = args['slug']
  const email     = args['admin-email']
  const firstName = args['admin-first-name']
  const lastName  = args['admin-last-name']
  if (!slug || !email || !firstName || !lastName) {
    throw new ScriptArgError(
      `argomenti mancanti. Uso: --slug <slug> --admin-email <email> --admin-first-name <nome> --admin-last-name <cognome> [${PASSWORD_STDIN_FLAG}]`,
    )
  }

  const adminRole = args['admin-role']!
  if (!ALLOWED_ROLES.includes(adminRole as Args['adminRole'])) {
    throw new ScriptArgError(`--admin-role deve essere uno di: ${ALLOWED_ROLES.join(', ')}`)
  }
  const plan = args['plan']!
  if (!ALLOWED_PLANS.includes(plan as Tenant['plan'])) {
    throw new ScriptArgError(`--plan deve essere uno di: ${ALLOWED_PLANS.join(', ')}`)
  }
  const timezone = args['timezone']!
  // emailDigestWorker fails loud on an invalid Tenant.timezone: reject it here.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new ScriptArgError(`--timezone "${timezone}" non è una zona IANA valida (es. Europe/Rome)`)
  }

  return {
    slug, email, firstName, lastName,
    domain:     args['domain']!,
    adminRole:  adminRole as Args['adminRole'],
    piIp:       args['pi-ip'],
    tenantName: args['name'] ?? slug,
    plan:       plan as Tenant['plan'],
    timezone,
  }
}

// Per-plan defaults for TenantSettings (packages/types). Stored flattened on
// the node (Neo4j has no nested maps): sla_enabled, scripting_enabled,
// max_users, max_ci.
const PLAN_SETTINGS: Record<Tenant['plan'], Tenant['settings']> = {
  starter:    { sla_enabled: true, scripting_enabled: false, max_users: 25,   max_ci: 500 },
  pro:        { sla_enabled: true, scripting_enabled: true,  max_users: 250,  max_ci: 10_000 },
  enterprise: { sla_enabled: true, scripting_enabled: true,  max_users: 5000, max_ci: 200_000 },
}

// ── Step 1: Realm ─────────────────────────────────────────────────────────────

async function createRealm(kc: KeycloakAdmin, token: string, a: Args): Promise<void> {
  const { created } = await kc.post(token, '/admin/realms', {
    realm:       a.slug,
    enabled:     true,
    sslRequired: 'none',
    displayName: a.slug,
  })
  console.log(created ? `  ✓ Realm "${a.slug}" creato` : `  ↩ Realm "${a.slug}" già esistente — skip`)
}

// ── Step 2: Clients ───────────────────────────────────────────────────────────

async function createClient(kc: KeycloakAdmin, token: string, a: Args): Promise<string> {
  const { id, created } = await kc.post(token, `/admin/realms/${a.slug}/clients`, {
    clientId:     'opengrafo-web',
    publicClient: true,
    enabled:      true,
    redirectUris: [
      // Production
      `https://${a.slug}.${a.domain}/*`,
      ...(a.piIp ? [`https://${a.slug}.${a.piIp}.nip.io/*`] : []),
      // Local Docker / dev — all access patterns
      `http://${a.slug}.localhost/*`,          // nginx-dev on port 80
      `http://${a.slug}.localhost:5173/*`,     // web container direct
      `http://*.localhost/*`,                  // any localhost subdomain (port 80)
      `http://*.localhost:5173/*`,             // any localhost subdomain on 5173
      `http://*.localhost:8080/*`,             // Keycloak post-login redirects
    ],
    webOrigins: ['+'],  // derive allowed origins from redirectUris
  })

  if (created && id) {
    console.log(`  ✓ Client "opengrafo-web" creato (id: ${id})`)
    return id
  }

  // Already exists — retrieve the id via GET
  const clients = await kc.get<{ id: string; clientId: string }[]>(
    token,
    `/admin/realms/${a.slug}/clients?clientId=opengrafo-web`,
  )
  const existing = clients[0]
  if (!existing) throw new Error('Client "opengrafo-web" non trovato dopo 409 — stato inatteso')
  console.log(`  ↩ Client "opengrafo-web" già esistente (id: ${existing.id}) — skip`)
  return existing.id
}

async function createPortalClient(kc: KeycloakAdmin, token: string, a: Args): Promise<void> {
  const { id, created } = await kc.post(token, `/admin/realms/${a.slug}/clients`, {
    clientId:     'opengrafo-portal',
    publicClient: true,
    enabled:      true,
    redirectUris: [
      // Production
      `https://portal.${a.slug}.${a.domain}/*`,
      ...(a.piIp ? [`https://portal.${a.slug}.${a.piIp}.nip.io/*`] : []),
      // Local Docker / dev
      `http://portal.${a.slug}.localhost/*`,       // nginx-dev on port 80
      `http://portal.${a.slug}.localhost:5174/*`,  // portal container direct
      `http://*.localhost/*`,                      // any localhost subdomain (port 80)
      `http://*.localhost:5174/*`,                 // any localhost subdomain on 5174
      `http://localhost:5174/*`,                   // bare localhost (VITE_TENANT_SLUG fallback)
    ],
    webOrigins: ['+'],
  })
  console.log(created && id ? `  ✓ Client "opengrafo-portal" creato (id: ${id})` : `  ↩ Client "opengrafo-portal" già esistente — skip`)
}

// ── Step 3: Roles ─────────────────────────────────────────────────────────────

async function createRoles(kc: KeycloakAdmin, token: string, a: Args): Promise<void> {
  let created = 0
  for (const name of ALLOWED_ROLES) {
    const { created: wasCreated } = await kc.post(token, `/admin/realms/${a.slug}/roles`, { name })
    if (wasCreated) created++
  }
  if (created === ALLOWED_ROLES.length) {
    console.log(`  ✓ Ruoli creati: ${ALLOWED_ROLES.join(', ')}`)
  } else {
    console.log(`  ↩ Ruoli già esistenti (${ALLOWED_ROLES.length - created} skippati)`)
  }
}

// ── Step 4: Realm role mapper ─────────────────────────────────────────────────

async function addRoleMapper(kc: KeycloakAdmin, token: string, a: Args, clientId: string): Promise<void> {
  const { created } = await kc.post(
    token,
    `/admin/realms/${a.slug}/clients/${clientId}/protocol-mappers/models`,
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
  console.log(created ? `  ✓ Mapper "realm roles" aggiunto al client` : `  ↩ Mapper "realm roles" già esistente — skip`)
}

// ── Step 5: Admin user ────────────────────────────────────────────────────────

async function createAdminUser(kc: KeycloakAdmin, token: string, a: Args, password: ResolvedPassword): Promise<void> {
  const { id: newId, created } = await kc.post(token, `/admin/realms/${a.slug}/users`, {
    username:      a.email,
    email:         a.email,
    emailVerified: true,
    enabled:       true,
    firstName:     a.firstName,
    lastName:      a.lastName,
  })

  let userId: string
  if (created && newId) {
    userId = newId
  } else {
    userId = await findUserIdByEmail(kc, token, a.slug, a.email)
    console.log(`  ↩ Utente "${a.email}" già esistente — skip creazione (password invariata)`)
  }

  // Set password only for newly created users
  if (created) {
    await kc.setPassword(token, a.slug, userId, password.value, password.temporary)
  }

  // Assign role (idempotent — Keycloak ignores duplicate role assignments)
  await assignRealmRole(kc, token, a.slug, userId, a.adminRole, false)

  if (created) console.log(`  ✓ Utente admin creato: ${a.email} (id: ${userId})`)
}

// ── Step 6: Neo4j ─────────────────────────────────────────────────────────────

async function provisionNeo4j(a: Args): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  const now     = new Date().toISOString()
  const { slug, email } = a

  try {
    // 6.0 Tenant node — the anchor every per-tenant background job enumerates
    // (`MATCH (t:Tenant) RETURN t.id`): without it the anomaly scanner and the
    // email digest never run for this tenant. id = slug (tenant_id everywhere),
    // slug kept as an explicit property for scripts matching on it.
    const settings = PLAN_SETTINGS[a.plan]
    const tenantResult = await session.executeWrite((tx) =>
      tx.run(
        `MERGE (t:Tenant {id: $id})
         ON CREATE SET
           t.slug              = $slug,
           t.name              = $name,
           t.plan              = $plan,
           t.timezone          = $timezone,
           t.sla_enabled       = $slaEnabled,
           t.scripting_enabled = $scriptingEnabled,
           t.max_users         = $maxUsers,
           t.max_ci            = $maxCi,
           t.created_at        = $now
         RETURN (t.created_at = $now) AS wasCreated, t.plan AS plan, t.timezone AS timezone`,
        {
          id: slug, slug, name: a.tenantName, plan: a.plan, timezone: a.timezone, now,
          slaEnabled: settings.sla_enabled, scriptingEnabled: settings.scripting_enabled,
          maxUsers: settings.max_users, maxCi: settings.max_ci,
        },
      ),
    )
    const tenantRow = tenantResult.records[0]
    if (!tenantRow) throw new Error(`MERGE (:Tenant {id: "${slug}"}) non ha restituito righe — stato inatteso`)
    if (tenantRow.get('wasCreated') as boolean) {
      console.log(`  ✓ Tenant Neo4j creato: ${slug} (plan: ${a.plan}, timezone: ${a.timezone})`)
    } else {
      console.log(`  ↩ Tenant Neo4j già esistente: ${slug} (plan: ${String(tenantRow.get('plan'))}, timezone: ${String(tenantRow.get('timezone'))}) — skip`)
    }

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
        { email, tenantId: slug, id: userId, name: `${a.firstName} ${a.lastName}`, role: a.adminRole, now },
      ),
    )
    const userCreated = userResult.records[0]?.get('wasCreated') as boolean
    console.log(userCreated ? `  ✓ User Neo4j creato: ${email} (tenant_id: ${slug})` : `  ↩ User Neo4j già esistente: ${email} — skip`)

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
    console.log(dashCreated ? `  ✓ DashboardConfig default creato` : `  ↩ DashboardConfig già esistente — skip`)

    // 6c. Notification rules default
    await seedNotificationRules(slug, session)

    // 6d. Seed system enum types
    await seedSystemEnumTypes(slug, session)
    console.log(`  ✓ System enum types seeded`)

    // 6f/6g. Verify shared CITypeDefinitions (scope='base' / 'itil')
    for (const [scope, seedScript] of [['base', 'seed-metamodel.ts'], ['itil', 'seed-itil-metamodel.ts']] as const) {
      const res = await session.executeRead((tx) =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE t.scope = $scope AND t.active = true
           RETURN count(t) AS total`,
          { scope },
        ),
      )
      const count = (res.records[0]?.get('total') as { toNumber(): number })?.toNumber() ?? 0
      if (count === 0) {
        console.warn(`  ⚠ Nessun CITypeDefinition scope='${scope}' trovato — esegui ${seedScript}`)
      } else {
        console.log(`  ✓ ${count} CITypeDefinition ${scope} disponibili`)
      }
    }
  } finally {
    await session.close()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const a  = parseCliArgs(process.argv.slice(2))
  const kc = createKeycloakAdmin(keycloakConfigFromEnv())
  const password = await resolvePassword(process.argv.slice(2))

  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  OpenGrafo — Onboarding tenant: ${a.slug.padEnd(8)} ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  console.log('▶ Keycloak')
  const token    = await kc.getAdminToken()
  await createRealm(kc, token, a)
  const clientId = await createClient(kc, token, a)
  await createPortalClient(kc, token, a)
  await createRoles(kc, token, a)
  await addRoleMapper(kc, token, a, clientId)
  await createAdminUser(kc, token, a, password)

  console.log('\n▶ Neo4j')
  await provisionNeo4j(a)

  // Every ticket type needs its WorkflowDefinition before the first create*
  // (createInstance fails loud without one). All seeds are idempotent MERGEs.
  console.log('\n▶ Workflow')
  await seedWorkflowForTenant(a.slug)
  console.log(`  ✓ Incident workflows seeded (base + security)`)
  await seedProblemWorkflowForTenant(a.slug)
  console.log(`  ✓ Problem workflow seeded`)
  await seedKBWorkflowForTenant(a.slug)
  console.log(`  ✓ KB Article workflow seeded`)
  for (const def of [CHANGE_RFC_WORKFLOW, SERVICE_REQUEST_WORKFLOW]) {
    const res = await seedWorkflowDefinition(a.slug, def)
    console.log(`  ✓ "${def.name}" ${res.created ? 'seeded' : 'already present — updated'} (defId: ${res.definitionId})`)
  }

  // Riepilogo SENZA password; quella generata è stampata una sola volta sotto.
  console.log(`
╔══════════════════════════════════════════════════════╗
║  Tenant "${a.slug}" pronto!
╠══════════════════════════════════════════════════════╣
║  URL locale:     http://${a.slug}.localhost:5173
║  URL produzione: https://${a.slug}.${a.domain}
║
║  Keycloak realm: ${a.slug}
║  Admin login:    ${a.email}
╚══════════════════════════════════════════════════════╝`)
  printOneTimePassword(a.email, password)
}

runScript('onboard-tenant', main)
