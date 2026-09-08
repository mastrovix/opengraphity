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
const SCAN_DIRS = [
  join(ROOT, 'apps', 'api', 'src'),
  ...readdirSync(join(ROOT, 'packages'))
    .map((p) => join(ROOT, 'packages', p, 'src'))
    .filter((d) => exists(d)),
]

/** Documented in .env.example but read only by docker-compose / build tooling, never by the code. */
const COMPOSE_ONLY = new Set([
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
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

let failed = false
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
console.log(`infra/.env.example is in sync: ${[...used.keys()].filter((n) => !NOT_CONFIG.has(n)).length} variable(s) used by the code, all documented; no dead keys.`)
