/**
 * Add a user to an existing tenant.
 * Idempotent: if the user already exists, updates its role in the graph (and
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
import { ScriptArgError } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { createKeycloakAdmin, findUserIdByEmail, keycloakConfigFromEnv, type KeycloakAdmin } from './lib/keycloakAdmin.js'
import { PASSWORD_STDIN_FLAG, assertNoPasswordInArgv, printOneTimePassword, resolvePassword, type ResolvedPassword } from './lib/password.js'

// ── Args ──────────────────────────────────────────────────────────────────────

/**
 * Il ruolo è la CHIAVE di un ruolo dell'organizzazione (ondata 7 di «Nulla
 * cablato»): uno di fabbrica o uno creato dalla pagina Ruoli. Si verifica nel
 * grafo PRIMA di toccare Keycloak (`assertTenantRole`), e un ruolo che il tenant
 * non ha è rifiutato con l'elenco di quelli validi.
 *
 * Storia (D-13): qui c'erano `user` e `manager`, che l'API rifiuta al login, e
 * `user` era persino il DEFAULT. Il ruolo resta obbligatorio: meglio un errore
 * al comando che un utente che non riesce a entrare.
 */
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/
type Role = string

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
      `argomenti mancanti. Uso: --slug <slug> --email <email> --role <chiave del ruolo> [--username <u>] [--first-name <n>] [--last-name <c>] [${PASSWORD_STDIN_FLAG}]`,
    )
  }

  if (!ROLE_KEY_RE.test(role)) {
    throw new ScriptArgError(`--role "${role}" non è la chiave di un ruolo (minuscole, cifre e _; la chiave è nella pagina Ruoli)`)
  }

  // first-name / last-name opzionali: derivati da username o email se assenti
  const username  = args['username'] ?? email
  const firstName = args['first-name'] ?? username.split(/[@._]/)[0] ?? 'Utente'
  const lastName  = args['last-name']  ?? ''

  return { slug, email, username, firstName, lastName, role: role as Role, passwordStdin: args['password-stdin'] ?? false }
}

// ── Step 0: il ruolo esiste nell'organizzazione ───────────────────────────────

async function assertTenantRole(a: Args): Promise<void> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(
      `MATCH (r:Role {tenant_id: $tenantId})
       RETURN r.key AS key, r.name AS name ORDER BY r.is_factory DESC, r.key`,
      { tenantId: a.slug },
    ))
    const roles = res.records.map((r) => ({ key: r.get('key') as string, name: r.get('name') as string | null }))
    if (roles.length === 0) {
      throw new Error(`Il tenant "${a.slug}" non ha ruoli: esegui migrate.js (i ruoli di fabbrica nascono con la migrazione 20260928_1000_factory_roles).`)
    }
    if (!roles.some((r) => r.key === a.role)) {
      const list = roles.map((r) => (r.name ? `${r.key} (${r.name})` : r.key)).join(', ')
      throw new ScriptArgError(`--role "${a.role}" non è un ruolo di "${a.slug}". Ruoli validi: ${list}`)
    }
    console.log(`  ✓ Ruolo "${a.role}" presente in "${a.slug}"`)
  } finally {
    await session.close()
  }
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
    console.log(`  ↩ Utente già esistente in Keycloak`)
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

  // Il ruolo NON si copia in Keycloak (ondata 7): l'app lo legge solo dal grafo,
  // e una copia nel realm diventerebbe falsa alla prima modifica dalla pagina Ruoli.
  if (created) console.log(`  ✓ Utente creato in Keycloak: ${a.email} (id: ${userId})`)
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

  console.log('▶ Ruolo')
  await assertTenantRole(a)

  console.log('\n▶ Keycloak')
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
