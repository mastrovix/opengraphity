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

import { parseArgs } from 'node:util'
import { FACTORY_ROLE_PERMISSIONS, USERS_ADMIN_PERMISSION, USER_ROLES, type Tenant } from '@opengraphity/types'
import { DEFAULT_TENANT_PLAN, DEFAULT_TENANT_TIMEZONE } from '../lib/tenantPlans.js'
import { ScriptArgError } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { onboardTenant } from '../lib/tenantOnboarding.js'
import { createKeycloakAdmin, keycloakConfigFromEnv } from './lib/keycloakAdmin.js'
import { PASSWORD_STDIN_FLAG, assertNoPasswordInArgv, printOneTimePassword, resolvePassword } from './lib/password.js'

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const a  = parseCliArgs(process.argv.slice(2))
  const kc = createKeycloakAdmin(keycloakConfigFromEnv())
  const password = await resolvePassword(process.argv.slice(2))

  console.log(`\n╔══════════════════════════════════════════╗`)
  console.log(`║  OpenGrafo — Onboarding tenant: ${a.slug.padEnd(8)} ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  /*
   * La logica sta in `lib/tenantOnboarding.ts`, condivisa con la console di
   * piattaforma (17 set 2026): due copie di «come nasce un cliente» sarebbero
   * divergute al primo cambio, e un tenant creato dalla strada sbagliata
   * sarebbe nato a metà. Qui resta la riga di comando — argomenti, password da
   * stdin, e la stampa.
   */
  await onboardTenant(
    kc,
    {
      slug: a.slug, tenantName: a.tenantName, plan: a.plan, timezone: a.timezone,
      email: a.email, firstName: a.firstName, lastName: a.lastName,
      adminRole: a.adminRole, domain: a.domain, production: a.production, piIp: a.piIp,
    },
    { value: password.value, temporary: password.temporary },
    {
      onStep: (linea) => console.log(`  • ${linea}`),
      // La password si mostra NELL'ISTANTE in cui è stata impostata, non alla
      // fine: è la lezione scritta in testa al modulo condiviso.
      onPassword: (email) => printOneTimePassword(email, password),
    },
  )

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
