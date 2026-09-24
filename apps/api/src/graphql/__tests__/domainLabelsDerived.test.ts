/**
 * THE LIST OF TENANT LABELS, CHECKED AGAINST THE CODE THAT WRITES THEM
 * (review of 23 Sep 2026, architecture#7 — wave 7 · A3).
 *
 * The three tenant lints (tenantScoping, tenantOnCreate) key on
 * DOMAIN_LABELS, written by hand, and the list had fallen behind: `Task`
 * (the generic ticket tasks of 20 Sep, nineteen query sites), `Proposal`,
 * `ProposalRejection`, `AIUsage` and `DemoDataRun` carried a `tenant_id` and
 * were not in it. A MATCH on them without a tenant passed with no marker at
 * all — the lints did not know they were a customer's data.
 *
 * Here the list is derived from the code that writes: every label a
 * `CREATE`/`MERGE` writes with a `tenant_id` (in its map, or set on its alias
 * in the same statement), and every label the demo generator's writer stamps
 * with the tenant. Each must be in DOMAIN_LABELS. The perimeter is the lints'
 * own — the API and the packages, without the operational scripts.
 *
 * What stays out, by design: labels built at run time (`CREATE (n:${label})`,
 * the CI types of a tenant's metamodel). Those carry `:ConfigurationItem`,
 * which is in the list. The live graph is the other source — C2 runs
 * `CALL db.labels()` against a real Neo4j.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMAIN_LABELS } from './domainLabels'

const here = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '../..')
const ROOTS = [apiSrc, ...readdirSync(join(apiSrc, '../../../packages')).map((p) => join(apiSrc, '../../../packages', p, 'src'))]
const EXCLUDED_DIRS = new Set(['__tests__', 'scripts', 'node_modules', 'dist'])

function listFiles(dir: string): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  const out: string[] = []
  for (const f of entries) {
    const child = join(dir, f)
    if (statSync(child).isDirectory()) {
      if (!EXCLUDED_DIRS.has(f)) out.push(...listFiles(child))
    } else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) {
      out.push(child)
    }
  }
  return out
}

const NODE_RE = /\((\w*)((?::`?\w+`?)+)\s*(\{)?/g
const CLAUSE_RE = /\b(MATCH|MERGE|CREATE)\b/g

/** The text of the map that opens right before `from`, up to its closing brace. */
function mapText(rest: string): string {
  let depth = 1
  let i = 0
  while (i < rest.length && depth > 0) {
    if (rest[i] === '{') depth++
    else if (rest[i] === '}') depth--
    i++
  }
  return rest.slice(0, i)
}

/**
 * The labels `source` writes with a tenant: node patterns of a CREATE or
 * MERGE clause (the last clause keyword before them in the same template)
 * whose map holds `tenant_id`, or whose alias gets `alias.tenant_id = …` in
 * the rest of the statement; and the labels of the generator's `w.nodes([…])`.
 */
export function labelsWrittenWithTenant(source: string): string[] {
  const found = new Set<string>()
  for (const m of source.matchAll(NODE_RE)) {
    const start = m.index
    const before = source.slice(0, start)
    const statementStart = before.lastIndexOf('`')
    const clauses = [...before.slice(statementStart + 1).matchAll(CLAUSE_RE)]
    const clause = clauses.at(-1)?.[1]
    if (clause !== 'CREATE' && clause !== 'MERGE') continue
    const end = source.indexOf('`', start + m[0].length)
    const rest = source.slice(start + m[0].length, end === -1 ? source.length : end)
    const alias = m[1]!
    const inMap = m[3] !== undefined && mapText(rest).includes('tenant_id')
    const setOnAlias = alias !== '' && new RegExp(`\\b${alias}\\.tenant_id\\s*=`).test(rest)
    if (!inMap && !setOnAlias) continue
    for (const label of m[2]!.split(':').filter(Boolean)) found.add(label.replace(/`/g, ''))
  }
  for (const m of source.matchAll(/\.nodes\(\s*\[([^\]]*)\]/g)) {
    for (const l of m[1]!.matchAll(/'(\w+)'/g)) found.add(l[1]!)
  }
  return [...found].sort()
}

describe('the tenant labels, derived from the code that writes them (A3)', () => {
  it('sees a label written with a tenant in a map, along a path, set on its alias, or by the generator', () => {
    expect(labelsWrittenWithTenant('`CREATE (p:Proposal {\n  id: $id, tenant_id: $tenantId })`')).toEqual(['Proposal'])
    expect(labelsWrittenWithTenant('`MERGE (ticket)-[:HAS_TASK]->(k:Task {tenant_id: $tenantId, task_key: $k})`')).toEqual(['Task'])
    expect(labelsWrittenWithTenant('`CREATE (a:Attachment:File {id: $id})\nSET a.tenant_id = $tenantId`')).toEqual(['Attachment', 'File'])
    expect(labelsWrittenWithTenant("await w.nodes(['DemoDataRun'], [{ id }])")).toEqual(['DemoDataRun'])
  })

  it('does not take a read, a write without a tenant, or the alias of another statement', () => {
    expect(labelsWrittenWithTenant('`MATCH (i:Incident {id: $id, tenant_id: $tenantId})`')).toEqual([])
    expect(labelsWrittenWithTenant('`MERGE (s:SchemaSeed {id: $id})`')).toEqual([])
    expect(labelsWrittenWithTenant('`CREATE (x:Marker {id: 1})` + `MATCH (x:Other) SET x.tenant_id = 1`')).toEqual([])
    expect(labelsWrittenWithTenant('`MATCH (c:Change {tenant_id: $t})\nCREATE (c)-[:HAS]->(n:Note {text: $x})`')).toEqual([])
  })

  const files = ROOTS.flatMap(listFiles)
  const written = new Map<string, string[]>()
  for (const f of files) {
    for (const label of labelsWrittenWithTenant(readFileSync(f, 'utf8'))) {
      written.set(label, [...(written.get(label) ?? []), relative(apiSrc, f)])
    }
  }

  it('the scan reaches the code: the ticket labels and the SLA status are among what it finds', () => {
    for (const label of ['Incident', 'Problem', 'Change', 'ServiceRequest', 'SLAStatus', 'WorkflowInstance', 'Task']) {
      expect(written.has(label), label).toBe(true)
    }
    expect(written.size).toBeGreaterThan(60)
  })

  it('every label the code writes with a tenant is in DOMAIN_LABELS, so the tenant lints check it', () => {
    const listed = new Set<string>(DOMAIN_LABELS)
    const missing = [...written.entries()].filter(([label]) => !listed.has(label)).map(([label, where]) => `${label} (${where.slice(0, 3).join(', ')})`)
    expect(missing, 'add them to domainLabels.ts').toEqual([])
  })
})
