#!/usr/bin/env node
/**
 * G-08 — infra/.env.example must document exactly the environment variables
 * the runtime code reads.
 *
 * Extracts every variable name from apps/api/src and packages/*\/src
 * (excluding tests and dist) in these forms:
 *   process.env['NAME']   process.env.NAME   env['NAME']
 *   requireEnv('NAME')    envOrThrowInProd('NAME', …)   optionalEnv / boolEnv / intEnv / enumEnv('NAME', …)
 * and compares the set with the `NAME=` keys of infra/.env.example.
 *
 * Fails (exit 1) when a variable is used but not documented, or documented
 * but not used — unless it is in one of the explicit allowlists below.
 *
 * Usage: node scripts/check-env-example.mjs [--verbose]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_EXAMPLE = join(ROOT, 'infra', '.env.example')
const COMPOSE = join(ROOT, 'infra', 'docker-compose.yml')

/**
 * Terzo controllo (revisione totale · H-10): una variabile che il codice
 * dell'API legge deve anche ARRIVARE al container.
 *
 * `ATTACHMENT_MAX_MB_CAP`, `RATE_LIMIT_MAX`, `ANTHROPIC_MODEL`,
 * `BACKUP_RETENTION` e `BACKUP_SKIP_KEYCLOAK` erano documentate in
 * `.env.example`, citate da DEPLOY e OPERATIONS come la cosa da cambiare, e
 * non comparivano nell'`environment` di nessun servizio: l'operatore le
 * scriveva in `infra/.env`, riavviava, e il backup continuava a tenerne 14.
 * Questo controllo confrontava codice ↔ `.env.example`; ora guarda anche
 * `.env.example` ↔ compose.
 *
 * Fuori perimetro: le variabili che il compose non deve passare (quelle dei
 * bundle `VITE_`, quelle dei soli servizi di infrastruttura) e quelle
 * elencate qui sotto con il loro perché.
 */
const NOT_IN_COMPOSE = new Map([
  ['VITEST', 'la mette il runner dei test, non e configurazione'],
  ['REDIS_HOST', 'alternativa a REDIS_URL, che il compose passa: host+porta servono a chi non usa un URL'],
  ['REDIS_PORT', 'vedi REDIS_HOST'],
  ['INAPP_NOTIFICATION_RETENTION_DAYS',
    'la legge SOLO la migrazione 20260925_1100, che la trasforma nell\'impostazione per organizzazione: '
    + 'un container non ne ha bisogno (vedi il commento in .env.example)'],
])
const SCAN_DIRS = [
  join(ROOT, 'apps', 'api', 'src'),
  ...readdirSync(join(ROOT, 'packages'))
    .map((p) => join(ROOT, 'packages', p, 'src'))
    .filter((d) => exists(d)),
]

/** Documented in .env.example but read only by docker-compose / build tooling, never by the code. */
const COMPOSE_ONLY = new Set([
  'GRAFANA_ADMIN_PASSWORD',   // grafana service: GF_SECURITY_ADMIN_PASSWORD
  'TAILSCALE_HOST',           // nginx template (infra/nginx/default.conf.template)
  'KEYCLOAK_PUBLIC_ORIGIN',   // nginx template: CSP connect-src
  'TAILSCALE_TENANT_HOST',    // nginx template: X-Forwarded-Host of the Tailscale block
  'NGINX_API_MAX_BODY',       // nginx template: client_max_body_size on /api/ (H-11)
])
/** Prefix for the frontend build variables (apps/web, apps/portal — not scanned). */
const FRONTEND_PREFIX = 'VITE_'
/** Read by the code but internal to a runtime/test tool — not configuration. */
const NOT_CONFIG = new Set([
  'VITEST',   // set by the vitest runner (packages/neo4j/src/driver.ts detects it)
])

const verbose = process.argv.includes('--verbose')

function exists(p) {
  try { statSync(p); return true } catch { return false }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      yield* walk(full)
    } else if (/\.(ts|mts|cts|js|mjs)$/.test(entry) && !/\.(test|spec)\.[cm]?[jt]s$/.test(entry)) {
      yield full
    }
  }
}

const PATTERNS = [
  /(?:process\.)?env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /\b(?:requireEnv|envOrThrowInProd|optionalEnv|boolEnv|intEnv|enumEnv)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
]

const used = new Map()   // name → Set<file:line>
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const re of PATTERNS) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(line)) !== null) {
          const name = m[1]
          if (!used.has(name)) used.set(name, new Set())
          used.get(name).add(`${file.slice(ROOT.length + 1)}:${i + 1}`)
        }
      }
    })
  }
}

const documented = new Set()
for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
  const m = /^([A-Z][A-Z0-9_]*)=/.exec(line)
  if (m) documented.add(m[1])
}

const usedNotDocumented = [...used.keys()].filter((n) => !documented.has(n) && !NOT_CONFIG.has(n)).sort()
const documentedNotUsed = [...documented].filter((n) => !used.has(n) && !COMPOSE_ONLY.has(n) && !n.startsWith(FRONTEND_PREFIX)).sort()

if (verbose) {
  console.log(`Scanned ${SCAN_DIRS.length} source roots; ${used.size} variable(s) used, ${documented.size} documented.`)
  for (const [name, sites] of [...used.entries()].sort()) console.log(`  ${name}: ${[...sites].join(', ')}`)
}

/**
 * Le variabili che compaiono nell'`environment` di un servizio del compose.
 * Un valore FISSO conta: `NEO4J_URI: bolt://neo4j:7687` e una scelta
 * dichiarata (dentro la rete docker l'indirizzo e quello e basta, non lo
 * decide infra/.env). Quello che questo controllo cerca e la variabile che
 * non compare per NIENTE: quella l'operatore la scrive in infra/.env e non
 * succede nulla.
 */
const composeText = readFileSync(COMPOSE, 'utf8')
const passedByCompose = new Set(
  [...composeText.matchAll(/^\s{4,}([A-Z][A-Z0-9_]*):\s/gm)].map((m) => m[1]),
)

const documentedNotPassed = [...documented]
  .filter((n) => used.has(n)
    && !n.startsWith(FRONTEND_PREFIX)
    && !COMPOSE_ONLY.has(n)
    && !NOT_IN_COMPOSE.has(n)
    && !passedByCompose.has(n))
  .sort()

let failed = false
if (documentedNotPassed.length > 0) {
  failed = true
  console.error('Environment variables the API code READS and infra/.env.example documents, but docker-compose.yml never passes to a container (so writing them in infra/.env changes nothing):')
  for (const n of documentedNotPassed) console.error(`  - ${n}  (${[...used.get(n)].slice(0, 2).join(', ')})`)
}
if (usedNotDocumented.length > 0) {
  failed = true
  console.error('Environment variables USED by the code but NOT documented in infra/.env.example:')
  for (const n of usedNotDocumented) console.error(`  - ${n}  (${[...used.get(n)].slice(0, 3).join(', ')})`)
}
if (documentedNotUsed.length > 0) {
  failed = true
  console.error('Environment variables DOCUMENTED in infra/.env.example but NOT read by any code (remove them, or add to COMPOSE_ONLY in scripts/check-env-example.mjs):')
  for (const n of documentedNotUsed) console.error(`  - ${n}`)
}

if (failed) {
  console.error('\ninfra/.env.example is out of sync with the code. Document every used variable (with a comment and a fake placeholder) or drop the dead ones.')
  process.exit(1)
}
console.log(`infra/.env.example is in sync: ${[...used.keys()].filter((n) => !NOT_CONFIG.has(n)).length} variable(s) used by the code, all documented; no dead keys; ${passedByCompose.size} passed by docker-compose.yml.`)
