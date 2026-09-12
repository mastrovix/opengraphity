/**
 * Add a user to an existing tenant.
 * Idempotent: if the user already exists in Keycloak, updates its role (and
 * the password only when one is supplied via --password-stdin).
 *
 * Usage:
 *   pnpm --filter @opengraphity/api add-user -- \
 *     --slug c-one \
 *     --email mario@acme.com \
 *     --role operator \
 *     [--username mario] [--first-name Mario] [--last-name Rossi] \
 *     [--password-stdin]
 *
 * Password (mai in argv — `--password X` è rifiutato):
 *   - `--password-stdin`: letta da stdin  → printf '%s' "$PWD" | pnpm … add-user -- … --password-stdin
 *   - senza flag: generata casualmente, impostata come temporanea in Keycloak
 *     (cambio obbligatorio al primo login) e stampata UNA volta.
 *
 * Required env vars:
 *   KEYCLOAK_ADMIN_PASSWORD (nessun default); KEYCLOAK_URL, KEYCLOAK_ADMIN_USER
 *   (default locali solo fuori produzione); NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import { v4 as uuidv4 } from 'uuid'
import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'
import { USER_ROLES, type UserRole } from '@opengraphity/types'
import { ScriptArgError } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { assignRealmRole, createKeycloakAdmin, findUserIdByEmail, keycloakConfigFromEnv, type KeycloakAdmin } from './lib/keycloakAdmin.js'
import { PASSWORD_STDIN_FLAG, assertNoPasswordInArgv, printOneTimePassword, resolvePassword, type ResolvedPassword } from './lib/password.js'

// ── Args ──────────────────────────────────────────────────────────────────────

/**
 * I ruoli che l'autenticazione accetta, importati (non copiati) da
 * @opengraphity/types: `USER_ROLES`, la stessa lista di `assertRole`
 * (auth/resolveAuth.ts) e della policy RBAC (lib/authorization.ts).
 * Prima qui c'erano anche `user` e `manager`, che l'API rifiuta al login, e
 * `user` era persino il DEFAULT: `add-user` senza `--role` creava di serie un
 * utente che non riesce a entrare (D-13). Ora il ruolo è obbligatorio: meglio
 * un errore al comando che un utente inutilizzabile.
 */
const ALLOWED_ROLES = USER_ROLES
type Role = UserRole

interface Args {
  slug:      string
  email:     string
  username:  string
  firstName: string
  lastName:  string
  role:      Role
  passwordStdin: boolean
}

function parseCliArgs(argv: readonly string[]): Args {
  // Messaggio dedicato PRIMA di parseArgs (che rifiuterebbe l'opzione ignota con un errore generico).
  assertNoPasswordInArgv(argv)

  const { values: args } = parseArgs({
    args: [...argv],
    options: {
      'slug':           { type: 'string' },
      'username':       { type: 'string' },   // Keycloak username (optional, defaults to email)
      'email':          { type: 'string' },
      'first-name':     { type: 'string' },
      'last-name':      { type: 'string' },
      'role':           { type: 'string' },   // obbligatorio: nessun default (un default invalido creava utenti che non entrano)
      'password-stdin': { type: 'boolean', default: false },
    },
  })

  const slug  = args['slug']
  const email = args['email']
  const role  = args['role']
  if (!slug || !email || !role) {
    throw new ScriptArgError(
      `argomenti mancanti. Uso: --slug <slug> --email <email> --role <${ALLOWED_ROLES.join('|')}> [--username <u>] [--first-name <n>] [--last-name <c>] [${PASSWORD_STDIN_FLAG}]`,
    )
  }

  if (!(ALLOWED_ROLES as readonly string[]).includes(role)) {
    throw new ScriptArgError(`--role deve essere uno di: ${ALLOWED_ROLES.join(', ')}`)
  }

  // first-name / last-name opzionali: derivati da username o email se assenti
  const username  = args['username'] ?? email
  const firstName = args['first-name'] ?? username.split(/[@._]/)[0] ?? 'Utente'
  const lastName  = args['last-name']  ?? ''

  return { slug, email, username, firstName, lastName, role: role as Role, passwordStdin: args['password-stdin'] ?? false }
}

// ── Step 1: Verify realm exists ───────────────────────────────────────────────

async function verifyRealm(kc: KeycloakAdmin, token: string, slug: string): Promise<void> {
  if (!(await kc.exists(token, `/admin/realms/${slug}`))) {
    throw new Error(`Realm "${slug}" non trovato in Keycloak. Crea prima il tenant con onboard-tenant.ts.`)
  }
  console.log(`  ✓ Realm "${slug}" verificato`)
}

// ── Step 2+3+4: Create/update user in Keycloak ────────────────────────────────

async function upsertKeycloakUser(kc: KeycloakAdmin, token: string, a: Args, password: ResolvedPassword): Promise<void> {
  const { id: newId, created } = await kc.post(token, `/admin/realms/${a.slug}/users`, {
    username:      a.username,
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
    console.log(`  ↩ Utente già esistente in Keycloak — aggiorno il ruolo`)
  }

  // Password: sempre per un utente nuovo; per uno esistente SOLO se fornita
  // esplicitamente via stdin (una password generata sovrascriverebbe quella
  // in uso a ogni riesecuzione, chiudendo fuori l'utente).
  if (created || password.source === 'stdin') {
    await kc.setPassword(token, a.slug, userId, password.value, password.temporary)
    console.log(`  ✓ Password ${password.source === 'generated' ? 'temporanea generata' : 'impostata da stdin'}`)
  } else {
    console.log(`  ↩ Password invariata (usa ${PASSWORD_STDIN_FLAG} per reimpostarla)`)
  }

  const { roleCreated } = await assignRealmRole(kc, token, a.slug, userId, a.role, true)
  if (roleCreated) console.log(`  + Ruolo "${a.role}" creato nel realm "${a.slug}"`)

  if (created) console.log(`  ✓ Utente creato in Keycloak: ${a.email} (id: ${userId})`)
  console.log(`  ✓ Ruolo "${a.role}" assegnato`)
}

// ── Step 5: Neo4j ─────────────────────────────────────────────────────────────

async function upsertNeo4jUser(a: Args): Promise<void> {
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
          email:    a.email,
          tenantId: a.slug,
          id:       uuidv4(),
          name:     `${a.firstName} ${a.lastName}`.trim(),
          role:     a.role,
          now,
        },
      ),
    )

    const wasCreated = result.records[0]?.get('wasCreated') as boolean
    if (wasCreated) {
      console.log(`  ✓ User Neo4j creato: ${a.email} (tenant_id: ${a.slug}, role: ${a.role})`)
    } else {
      console.log(`  ↩ User Neo4j aggiornato: ${a.email} (role: ${a.role})`)
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
  console.log(`║  OpenGrafo — Add user to tenant: ${a.slug.padEnd(7)} ║`)
  console.log(`╚══════════════════════════════════════════╝\n`)

  console.log('▶ Keycloak')
  const token = await kc.getAdminToken()
  await verifyRealm(kc, token, a.slug)
  await upsertKeycloakUser(kc, token, a, password)

  console.log('\n▶ Neo4j')
  await upsertNeo4jUser(a)

  // Riepilogo SENZA password; quella generata è stampata una sola volta sotto.
  console.log(`
╔══════════════════════════════════════════════╗
║  Utente aggiunto con successo!
╠══════════════════════════════════════════════╣
║  Tenant:  ${a.slug}
║  Email:   ${a.email}
║  Nome:    ${a.firstName} ${a.lastName}
║  Ruolo:   ${a.role}
╚══════════════════════════════════════════════╝`)
  printOneTimePassword(a.email, password)
}

runScript('add-user', main)
