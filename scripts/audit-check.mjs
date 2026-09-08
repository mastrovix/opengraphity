#!/usr/bin/env node
/**
 * G-10/G-11 — dependency audit gate for CI.
 *
 * Runs `pnpm audit --prod --json` and fails (exit 1) when an advisory of
 * severity >= --level (default: high) is present and is NOT accepted by
 * audit-allowlist.json. Each allowlist entry must carry the advisory id,
 * the reason it is accepted and an expiry date: once expired the entry no
 * longer counts and the run goes red again, so a temporary acceptance
 * cannot silently become permanent.
 *
 * Lower severities are reported but do not fail the run. Allowlist entries
 * that no longer match anything are reported as stale (prune them).
 *
 * The audit is a network call to the registry: a transport/registry error
 * is a failure, not a green run.
 *
 * Usage: node scripts/audit-check.mjs [--level=high|critical|moderate|low] [--json <file>]
 *   --json <file>  use a saved `pnpm audit --json` output instead of running pnpm
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST_PATH = join(ROOT, 'audit-allowlist.json')
const SEVERITIES = ['low', 'moderate', 'high', 'critical']

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
let level = 'high'
let jsonFile = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--level=')) level = a.slice('--level='.length)
  else if (a === '--level') level = args[++i]
  else if (a === '--json') jsonFile = args[++i]
  else fail(`unknown argument: ${a}`)
}
if (!SEVERITIES.includes(level)) fail(`--level must be one of ${SEVERITIES.join(', ')}`)
const gateIndex = SEVERITIES.indexOf(level)

// ── Allowlist ────────────────────────────────────────────────────────────────

/** @type {{ id: string, package: string, severity: string, reason: string, expires: string }[]} */
let allowlist = []
if (existsSync(ALLOWLIST_PATH)) {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  if (!Array.isArray(raw.entries)) fail(`${ALLOWLIST_PATH}: expected { "entries": [...] }`)
  allowlist = raw.entries
  for (const e of allowlist) {
    for (const k of ['id', 'package', 'severity', 'reason', 'expires']) {
      if (typeof e[k] !== 'string' || e[k].trim() === '') fail(`${ALLOWLIST_PATH}: entry ${JSON.stringify(e)} is missing "${k}"`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires) || Number.isNaN(Date.parse(e.expires))) {
      fail(`${ALLOWLIST_PATH}: entry ${e.id} has an invalid "expires" (YYYY-MM-DD expected)`)
    }
    if (!SEVERITIES.includes(e.severity)) fail(`${ALLOWLIST_PATH}: entry ${e.id} has an unknown severity "${e.severity}"`)
  }
}
const today = new Date().toISOString().slice(0, 10)

// ── Audit ────────────────────────────────────────────────────────────────────

let audit
if (jsonFile) {
  audit = JSON.parse(readFileSync(jsonFile, 'utf8'))
} else {
  // pnpm exits non-zero whenever vulnerabilities exist — the JSON on stdout is
  // what matters. Only a missing/unparsable body is an error.
  const res = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.error) fail(`could not run pnpm audit: ${res.error.message}`)
  try {
    audit = JSON.parse(res.stdout)
  } catch {
    fail(`pnpm audit did not return JSON (exit ${res.status}).\nstdout: ${res.stdout.slice(0, 500)}\nstderr: ${res.stderr.slice(0, 500)}`)
  }
}
if (!audit || typeof audit.advisories !== 'object' || !audit.metadata) {
  fail('unexpected pnpm audit output: no "advisories"/"metadata" keys')
}

// ── Evaluate ─────────────────────────────────────────────────────────────────

const advisories = Object.values(audit.advisories).map((a) => ({
  id: a.github_advisory_id || String(a.id),
  module: a.module_name,
  severity: a.severity,
  title: a.title,
  url: a.url,
  versions: [...new Set((a.findings ?? []).map((f) => f.version))].join(', '),
  path: [...new Set((a.findings ?? []).flatMap((f) => f.paths ?? []))][0] ?? '',
}))

const byId = new Map(allowlist.map((e) => [e.id, e]))
const usedIds = new Set()
const blocking = []
const accepted = []
const expired = []
const below = []

for (const adv of advisories) {
  const gated = SEVERITIES.indexOf(adv.severity) >= gateIndex
  const entry = byId.get(adv.id)
  if (entry) usedIds.add(adv.id)
  if (!gated) { below.push(adv); continue }
  if (!entry) { blocking.push(adv); continue }
  if (entry.expires < today) { expired.push({ adv, entry }); continue }
  accepted.push({ adv, entry })
}
const stale = allowlist.filter((e) => !usedIds.has(e.id))

// ── Report ───────────────────────────────────────────────────────────────────

const counts = audit.metadata.vulnerabilities ?? {}
console.log(`pnpm audit --prod: ${SEVERITIES.slice().reverse().map((s) => `${s}=${counts[s] ?? 0}`).join('  ')}  (gate: >= ${level})`)

const line = (adv) => `  - ${adv.severity.padEnd(8)} ${adv.module}@${adv.versions}  ${adv.id}  ${adv.title}\n      via ${adv.path}`

if (accepted.length) {
  console.log(`\nAccepted (allowlisted, not expired): ${accepted.length}`)
  for (const { adv, entry } of accepted) console.log(`${line(adv)}\n      reason: ${entry.reason} (until ${entry.expires})`)
}
if (below.length) {
  console.log(`\nBelow gate (reported only): ${below.length}`)
  for (const adv of below) console.log(line(adv))
}
if (stale.length) {
  console.log(`\nStale allowlist entries (no longer reported — remove them from audit-allowlist.json): ${stale.length}`)
  for (const e of stale) console.log(`  - ${e.id} ${e.package}`)
}
if (expired.length) {
  console.log(`\nEXPIRED allowlist entries: ${expired.length}`)
  for (const { adv, entry } of expired) console.log(`${line(adv)}\n      expired ${entry.expires}: ${entry.reason}`)
}
if (blocking.length) {
  console.log(`\nNEW vulnerabilities >= ${level} not in audit-allowlist.json: ${blocking.length}`)
  for (const adv of blocking) console.log(`${line(adv)}\n      ${adv.url}`)
}

if (blocking.length || expired.length) {
  console.error(`\naudit-check: FAILED — fix the dependency or add an entry (id, reason, expiry) to audit-allowlist.json`)
  process.exit(1)
}
console.log('\naudit-check: OK')

function fail(msg) {
  console.error(`audit-check: ${msg}`)
  process.exit(1)
}
