/**
 * GUARDIAN: A STATEMENT THAT IS LONG BY DESIGN CARRIES THE MAINTENANCE LIMIT
 * (review of 23 Sep 2026, wave 7 · A2).
 *
 * Since 24 Sep 2026 the database stops a transaction at 120 s
 * (`NEO4J_db_transaction_timeout` in the compose). Some statements last longer
 * on purpose: `CALL {…} IN TRANSACTIONS` keeps its outer transaction open for
 * the whole job — verified on neo4j 5.26.29, the server's timeout kills it
 * half way — and `db.awaitIndexes` waits for index population. Without the
 * maintenance limit a purge, a restore or a demo clean would stop after two
 * minutes with the work half done, and only on a big tenant: the tests'
 * databases are small.
 *
 * The rule: a source file with such a statement names `MAINTENANCE_TX_CONFIG`
 * (on the statement) or `MAINTENANCE_SCOPE` (around the work). The migrations
 * are the exception, and not by trust: their runner runs every one of them in
 * the maintenance scope, and this test checks that too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

const SCAN_DIRS = [
  join(ROOT, 'apps', 'api', 'src'),
  ...readdirSync(join(ROOT, 'packages')).map((p) => join(ROOT, 'packages', p, 'src')),
]

const MIGRATIONS_DIR = 'apps/api/src/scripts/migrations/'

function* sourceFiles(dir: string): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue
      yield* sourceFiles(full)
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      yield full
    }
  }
}

/** Comments out: the docs of these files name the statements they explain. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The long-by-design statements of a source, by line. */
function longStatements(text: string): number[] {
  const clean = withoutComments(text)
  return [...clean.matchAll(/IN\s+TRANSACTIONS|db\.awaitIndexes/g)].map((m) => clean.slice(0, m.index).split('\n').length)
}

const carriesTheLimit = (text: string): boolean => /\bMAINTENANCE_(TX_CONFIG|SCOPE)\b/.test(withoutComments(text))

describe('long-by-design statements carry the maintenance limit (wave 7 · A2)', () => {
  it('recognises the statements, and not in comments', () => {
    expect(longStatements('MATCH (n:X) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS')).toEqual([1])
    expect(longStatements("x\nawait session.run('CALL db.awaitIndexes(600)')")).toEqual([2])
    expect(longStatements('// `CALL … IN TRANSACTIONS` explained\n/* db.awaitIndexes */')).toEqual([])
    expect(carriesTheLimit('await session.run(q, {}, MAINTENANCE_TX_CONFIG)')).toBe(true)
    expect(carriesTheLimit('// MAINTENANCE_SCOPE in a comment only')).toBe(false)
  })

  it('every source outside the migrations with such a statement names the maintenance limit', () => {
    const missing: string[] = []
    let seen = 0
    for (const dir of SCAN_DIRS) {
      for (const file of sourceFiles(dir)) {
        const rel = relative(ROOT, file).split('\\').join('/')
        if (rel.startsWith(MIGRATIONS_DIR)) continue
        const text = readFileSync(file, 'utf8')
        const lines = longStatements(text)
        if (lines.length === 0) continue
        seen++
        if (!carriesTheLimit(text)) missing.push(`${rel}:${lines.join(',')}`)
      }
    }
    // The scan finds what it is meant to find: restore, tenant purge, demo clean, two retentions.
    expect(seen).toBeGreaterThanOrEqual(5)
    expect(missing, 'long statements without MAINTENANCE_TX_CONFIG / MAINTENANCE_SCOPE').toEqual([])
  })

  it('the migrations are covered by their runner, which runs every one in the maintenance scope', () => {
    const runner = readFileSync(join(ROOT, 'packages', 'neo4j', 'src', 'migrations.ts'), 'utf8')
    expect(withoutComments(runner)).toMatch(/runInQueryScope\(MAINTENANCE_SCOPE,\s*\(\)\s*=>\s*applyPending\(/)
    const withLongStatements = readdirSync(join(ROOT, MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => longStatements(readFileSync(join(ROOT, MIGRATIONS_DIR, f), 'utf8')).length > 0)
    expect(withLongStatements.length).toBeGreaterThanOrEqual(4)
  })

  it('the backup reads the whole graph in one transaction, and that transaction carries the limit', () => {
    const backup = withoutComments(readFileSync(join(ROOT, 'apps', 'api', 'src', 'scripts', 'backup-neo4j.ts'), 'utf8'))
    const begins = [...backup.matchAll(/beginTransaction\(([^)]*)\)/g)].map((m) => m[1])
    expect(begins).toEqual(['MAINTENANCE_TX_CONFIG'])
  })

  it('the schema initialisation runs in the maintenance scope', () => {
    const init = withoutComments(readFileSync(join(ROOT, 'packages', 'neo4j', 'src', 'init.ts'), 'utf8'))
    expect(init).toMatch(/runInQueryScope\(MAINTENANCE_SCOPE,\s*\(\)\s*=>\s*initSchemaSteps\(opts\)\)/)
  })
})
