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
 *     [--timezone Europe/Rome]         (default: UTC — must be a valid IANA zone; C-27)
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
import { getSession, toNumber } from '@opengraphity/neo4j'
import { FACTORY_ROLE_PERMISSIONS, USERS_ADMIN_PERMISSION, USER_ROLES, type Tenant } from '@opengraphity/types'
import { seedSystemEnumTypes } from '../lib/seedEnumTypes.js'
import { provisionTenantData } from '../lib/provisionTenantData.js'
import { DEFAULT_EVENT_POLICY_JSON } from '../lib/eventPolicy.js'
import { DEFAULT_TENANT_PLAN, DEFAULT_TENANT_TIMEZONE, PLAN_SETTINGS } from '../lib/tenantPlans.js'
import { ScriptArgError } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { createKeycloakAdmin, findUserIdByEmail, keycloakConfigFromEnv, type KeycloakAdmin } from './lib/keycloakAdmin.js'
import { PASSWORD_STDIN_FLAG, assertNoPasswordInArgv, printOneTimePassword, resolvePassword, type ResolvedPassword } from './lib/password.js'

// ── Args ──────────────────────────────────────────────────────────────────────

/**
 * Il ruolo del primo amministratore: un ruolo di fabbrica (`USER_ROLES`, gli
 * unici che un tenant appena nato ha) che gestisce persone e ruoli
 * (`admin.users`, ondata 7). Con un ruolo senza quel permesso l'organizzazione
 * nascerebbe senza nessuno capace di aggiungere persone o cambiare ruoli.
 * I ruoli NON si creano più in Keycloak: l'app li legge solo dal grafo.
 *
 * Storia (D-13): erano `['admin','user','manager']`, e `--admin-role manager`
 * creava un primo amministratore che al login veniva rifiutato.
 */
const ALLOWED_ROLES = USER_ROLES.filter((r) => FACTORY_ROLE_PERMISSIONS[r].includes(USERS_ADMIN_PERMISSION))
const ALLOWED_PLANS = ['starter', 'pro', 'enterprise'] as const satisfies readonly Tenant['plan'][]

interface Args {
  /**
   * Organizzazione di produzione (revisione totale · H-46): il realm esige
   * HTTPS e i redirect restano i suoi domini, senza i jolly `*.localhost` e
   * senza `webOrigins: ['+']`. Senza `--production` l'onboarding è quello di
   * sviluppo, come prima.
   */
  production: boolean
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
      'plan':             { type: 'string', default: DEFAULT_TENANT_PLAN },
      'timezone':         { type: 'string', default: DEFAULT_TENANT_TIMEZONE },
      'production':       { type: 'boolean', default: false },
    },
  })

  const slug      = args['slug']
  const email     = args['admin-email']?.trim().toLowerCase()
  const firstName = args['admin-first-name']
  const lastName  = args['admin-last-name']
  if (!slug || !email || !firstName || !lastName) {
    throw new ScriptArgError(
      `argomenti mancanti. Uso: --slug <slug> --admin-email <email> --admin-first-name <nome> --admin-last-name <cognome> [${PASSWORD_STDIN_FLAG}]`,
    )
  }

  const adminRole = args['admin-role']!
  if (!ALLOWED_ROLES.includes(adminRole as Args['adminRole'])) {
    throw new ScriptArgError(`--admin-role deve essere un ruolo che gestisce persone e ruoli: ${ALLOWED_ROLES.join(', ')}`)
  }
  const plan = args['plan']!
  if (!ALLOWED_PLANS.includes(plan as Tenant['plan'])) {
    throw new ScriptArgError(`--plan deve essere uno di: ${ALLOWED_PLANS.join(', ')}`)
  }
  const timezone = args['timezone']!
  /**
   * C-27: il default è UTC e lo si DICE. Il fuso decide le scadenze SLA, l'ora
   * del digest e le passate OLA: chi onboarda un cliente in un altro paese
   * deve accorgersi di non averlo scelto, invece di scoprirlo dalle scadenze.
   */
  if (timezone === DEFAULT_TENANT_TIMEZONE && !process.argv.some((a) => a.startsWith('--timezone'))) {
    console.log(`[onboard] nessun --timezone: il tenant nasce su ${DEFAULT_TENANT_TIMEZONE}. Le scadenze SLA, il digest e gli OLA useranno quest'ora — cambiala in Impostazioni → Organizzazione se il cliente è altrove.`)
  }
  // emailDigestWorker fails loud on an invalid Tenant.timezone: reject it here.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new ScriptArgError(`--timezone "${timezone}" non è una zona IANA valida (es. Europe/Rome)`)
  }

  return {
    production: args['production'] === true,
    slug, email, firstName, lastName,
    domain:     args['domain']!,
    adminRole:  adminRole as Args['adminRole'],
    piIp:       args['pi-ip'],
    tenantName: args['name'] ?? slug,
    plan:       plan as Tenant['plan'],
    timezone,
  }
}

// Per-plan defaults for TenantSettings: lib/tenantPlans.ts (PLAN_SETTINGS),
// shared with the migration that creates missing :Tenant nodes.

// ── Step 1: Realm ─────────────────────────────────────────────────────────────

async function createRealm(kc: KeycloakAdmin, token: string, a: Args): Promise<void> {
  const { created } = await kc.post(token, '/admin/realms', {
    realm:       a.slug,
    enabled:     true,
    // Produzione: l'accesso solo via HTTPS (revisione totale · H-46).
    sslRequired: a.production ? 'external' : 'none',
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
      // Local Docker / dev — all access patterns (mai in produzione: H-46)
      ...(a.production ? [] : [
        `http://${a.slug}.localhost/*`,          // nginx-dev on port 80
        `http://${a.slug}.localhost:5173/*`,     // web container direct
        `http://*.localhost/*`,                  // any localhost subdomain (port 80)
        `http://*.localhost:5173/*`,             // any localhost subdomain on 5173
        `http://*.localhost:8080/*`,             // Keycloak post-login redirects
      ]),
    ],
    webOrigins: a.production ? [`https://${a.slug}.${a.domain}`] : ['+'],
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
      // Local Docker / dev (mai in produzione: H-46)
      ...(a.production ? [] : [
        `http://portal.${a.slug}.localhost/*`,       // nginx-dev on port 80
        `http://portal.${a.slug}.localhost:5174/*`,  // portal container direct
        `http://*.localhost/*`,                      // any localhost subdomain (port 80)
        `http://*.localhost:5174/*`,                 // any localhost subdomain on 5174
        `http://localhost:5174/*`,                   // bare localhost (VITE_TENANT_SLUG fallback)
      ]),
    ],
    webOrigins: a.production ? [`https://portal.${a.slug}.${a.domain}`] : ['+'],
  })
  console.log(created && id ? `  ✓ Client "opengrafo-portal" creato (id: ${id})` : `  ↩ Client "opengrafo-portal" già esistente — skip`)
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
    // MOSTRATA SUBITO, non alla fine dello script (terza revisione).
    //
    // `printOneTimePassword` stava dopo il provisioning di Neo4j, e quando quel
    // passo e crollato — su un `toNumber` mancante, corretto qui sopra —
    // l'utente admin era stato creato con una password generata che NON e mai
    // stata mostrata: irrecuperabile, perche un nuovo giro dello script salta
    // la creazione e lascia la password invariata. Per un cliente vero il suo
    // primo amministratore resta chiuso fuori. Succede dal vivo, e con questo
    // ordine non puo piu succedere: fra l'impostare e il mostrare non c'e
    // niente che possa fallire.
    printOneTimePassword(a.email, password)
  }

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
    // slug kept as an explicit property for scripts matching on it. Same
    // property set as migrations/20260909_1010_event_management_fixup.ts.
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
           t.max_service_maps  = $maxServiceMaps,
           t.event_policy      = $eventPolicy,
           t.created_at        = $now
         RETURN (t.created_at = $now) AS wasCreated, t.plan AS plan, t.timezone AS timezone`,
        {
          id: slug, slug, name: a.tenantName, plan: a.plan, timezone: a.timezone, now,
          slaEnabled: settings.sla_enabled, scriptingEnabled: settings.scripting_enabled,
          maxUsers: settings.max_users, maxCi: settings.max_ci,
          maxServiceMaps: settings.max_service_maps,   // Servizi monitorati: stesso limite scritto sui tenant esistenti dalla 20260910_1100_service_map_plan_limit
          eventPolicy: DEFAULT_EVENT_POLICY_JSON,   // Event Management: stessa policy iniziale della migrazione 20260909_1010_event_management_fixup
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

    // 6b. Vocabolari spediti col prodotto — uno solo, su `tenant_id = 'system'`
    //     (A-2 / C-6): l'onboarding NON ne crea più una copia per tenant. Le
    //     copie sono le personalizzazioni e nascono da `customizeEnumType`.
    await seedSystemEnumTypes(session)
    console.log(`  ✓ Vocabolari spediti verificati su tenant_id='system' (nessuna copia per ${slug})`)

    // 6c. Il dato del tenant — dashboard, regole di notifica, matrici di
    //     dominio, definizioni di workflow — in UNA funzione condivisa con la
    //     migrazione che completa i tenant nati dall'altra strada (D-14: un
    //     tenant nasce in un modo solo). Additiva e idempotente: una
    //     definizione o una matrice già presenti NON vengono riallineate al
    //     seme, perché potrebbero essere personalizzazioni del cliente.
    const provisioned = await provisionTenantData(session, slug, { userId })
    console.log(provisioned.rolesCreated.length ? `  ✓ Ruoli di fabbrica creati: ${provisioned.rolesCreated.join(', ')}` : `  ↩ Ruoli già presenti — lasciati com'erano`)
    // Il ruolo del primo admin deve gestire persone e ruoli anche nel DATO: su un
    // tenant già esistente il ruolo di fabbrica può essere stato modificato.
    const adminRoleRes = await session.executeRead((tx) => tx.run(
      'MATCH (r:Role {tenant_id: $tenantId, key: $key}) RETURN $perm IN r.permissions AS ok',
      { tenantId: slug, key: a.adminRole, perm: USERS_ADMIN_PERMISSION },
    ))
    if (adminRoleRes.records[0]?.get('ok') !== true) {
      throw new Error(`Il ruolo "${a.adminRole}" di "${slug}" non gestisce persone e ruoli (${USERS_ADMIN_PERMISSION}): il primo amministratore non potrebbe farlo. Correggi il ruolo dalla pagina Ruoli o scegli --admin-role.`)
    }
    console.log(provisioned.dashboardCreated ? `  ✓ DashboardConfig default creato` : `  ↩ DashboardConfig già esistente — skip`)
    console.log(`  ✓ Regole di notifica: ${provisioned.notificationRulesCreated} create`)
    console.log(`  ✓ Matrici di dominio create per ${slug}: ${provisioned.matricesCreated.length === 0 ? 'nessuna (erano già presenti)' : provisioned.matricesCreated.join(', ')}`)
    for (const w of provisioned.workflows) {
      console.log(`  ✓ Workflow "${w.name}"${w.created === false ? ' — già presente, lasciata com\'è' : ''}`)
    }
    console.log('  ℹ Le definizioni già presenti NON sono state toccate (vedi le righe [workflow] sopra).')

    // 6d/6e. Verify shared CITypeDefinitions (scope='base' / 'itil')
    for (const [scope, seedScript] of [['base', 'seed-metamodel.ts'], ['itil', 'seed-itil-metamodel.ts']] as const) {
      const res = await session.executeRead((tx) =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE t.scope = $scope AND t.active = true
           RETURN count(t) AS total`,
          { scope },
        ),
      )
      // `toNumber` condiviso e non un cast a mano: il driver di questo
      // progetto restituisce i `count()` come NUMERI JS, non come Integer
      // di Neo4j, quindi `.toNumber()` non esiste e l'onboarding di un
      // cliente nuovo finiva con «✖ onboard-tenant fallito» DOPO aver creato
      // tutto — chi lo lanciava non sapeva se il tenant fosse usabile.
      const count = toNumber(res.records[0]?.get('total') ?? 0)
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
  await createClient(kc, token, a)
  await createPortalClient(kc, token, a)
  await createAdminUser(kc, token, a, password)

  console.log('\n▶ Neo4j')
  await provisionNeo4j(a)

  // Riepilogo SENZA password: quella generata e gia stata mostrata al momento
  // in cui e stata impostata (vedi `createAdminUser`).
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
}

runScript('onboard-tenant', main)
