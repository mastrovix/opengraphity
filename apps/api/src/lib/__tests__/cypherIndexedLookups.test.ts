/**
 * GUARDIAN: NO CYPHER LOOKUP BY ID OR TENANT WITHOUT A LABEL (D25).
 *
 * The browser tour of 23 Sep 2026 on the demo tenant (4.85 M nodes) found 109
 * queries like `MATCH (ci {id: $ciId, tenant_id: $tenantId})`. Without a label
 * Neo4j cannot use an index and reads every node of the database: 2.6 s per
 * call. The change calendar ran one per release window and hit the 60 s
 * gateway timeout; every assessment answer took 3 s, a CI detail 4 s, the
 * topology 11 s. Nothing in the tests noticed, because the test databases are
 * small: a full scan of a few hundred nodes is instant.
 *
 * The rule: a node pattern that starts a MATCH by `id` or `tenant_id` names a
 * label. CIs use `:ConfigurationItem`; a ticket whose type is not known goes
 * through `matchById` (one index seek per label, see
 * packages/types/src/cypherLookups.ts). Nodes reached through a relationship
 * from an anchored node are fine and are not checked.
 *
 * The exceptions below read everything on purpose; each is counted, so a new
 * occurrence in the same file still fails.
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

const UNLABELLED_FORMS: readonly { name: string; re: RegExp }[] = [
  { name: 'MATCH (x {id|tenant_id: …})', re: /(?:OPTIONAL\s+)?MATCH\s+(?:\w+\s*=\s*)?\((\w+)\s*\{\s*(?:id|tenant_id)\s*:/g },
  { name: 'MATCH (a:A {…}), (x {id|tenant_id: …})', re: /,\s*\((\w+)\s*\{\s*(?:id|tenant_id)\s*:/g },
  { name: 'MATCH (x) WHERE x.id|x.tenant_id', re: /(?:OPTIONAL\s+)?MATCH\s*\((\w+)\)\s*WHERE\s+\1\.(?:id|tenant_id)\b/g },
]

const ALLOWED: Readonly<Record<string, { count: number; reason: string }>> = {
  'apps/api/src/lib/tenantLifecycle.ts': {
    count: 3, reason: 'footprint and deletion of a whole tenant: every node of the tenant, whatever its label',
  },
  'apps/api/src/services/reportAgent.ts': {
    count: 2, reason: 'schema introspection for the AI analysis: every label the tenant has (cached per tenant)',
  },
  'apps/api/src/scripts/migrations/20260908_1010_ci_configuration_item_label.ts': {
    count: 1, reason: 'the migration that adds :ConfigurationItem to the nodes that miss it',
  },
  'apps/api/src/scripts/migrations/20260913_1310_tenant_fields_on_shared_types.ts': {
    count: 1, reason: 'one-off migration over the labels of the shared types',
  },
  'apps/api/src/scripts/migrations/20260923_1020_ticket_orphans_cleanup.ts': {
    count: 3, reason: 'one-off sweep of orphan SLAs and workflow instances, across ticket labels',
  },
  'apps/api/src/scripts/migrations/20260923_1030_comments_single_model.ts': {
    count: 1, reason: 'one-off migration of the comments of every entity type',
  },
}

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

/** Comments out: the rule is about queries, and the docs quote the forbidden forms. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function findUnlabelledLookups(text: string): { form: string; line: number }[] {
  const clean = withoutComments(text)
  const hits: { form: string; line: number }[] = []
  for (const { name, re } of UNLABELLED_FORMS) {
    for (const m of clean.matchAll(re)) {
      hits.push({ form: name, line: clean.slice(0, m.index).split('\n').length })
    }
  }
  return hits.sort((a, b) => a.line - b.line)
}

describe('Cypher lookups by id or tenant name a label (D25)', () => {
  it('recognises the three unlabelled forms and ignores labelled and anchored patterns', () => {
    const bad = [
      'MATCH (ci {id: $ciId, tenant_id: $tenantId})',
      'OPTIONAL MATCH (e {tenant_id: $tenantId, created_by: $userId})',
      'MATCH path = (target {id: $targetId, tenant_id: $tenantId})-[:DEPENDS_ON*1..10]->(s)',
      'MATCH (c:Application {id: $ciId}), (db {id: $dbId})',
      'MATCH (origin)\n  WHERE origin.id = $ciId',
    ]
    for (const q of bad) expect(findUnlabelledLookups(q), q).toHaveLength(1)
    const good = [
      'MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})',
      'MATCH (wi:WorkflowInstance {id: $id})-[:FOR]->(e {id: $x})',
      'MATCH (e)-[:HAS_SLA]->(s:SLAStatus {tenant_id: $tenantId})',
      '// MATCH (x {id: $id}) in a comment',
      '/* MATCH (x {id: $id}) in a block comment */',
    ]
    for (const q of good) expect(findUnlabelledLookups(q), q).toEqual([])
  })

  it('no source of the API or of the packages looks a node up by id or tenant without a label', () => {
    const found: string[] = []
    const perFile = new Map<string, number>()
    for (const dir of SCAN_DIRS) {
      for (const file of sourceFiles(dir)) {
        const rel = relative(ROOT, file).split('\\').join('/')
        const hits = findUnlabelledLookups(readFileSync(file, 'utf8'))
        if (hits.length === 0) continue
        perFile.set(rel, hits.length)
        if (!ALLOWED[rel]) for (const h of hits) found.push(`${rel}:${h.line}  ${h.form}`)
      }
    }
    expect(found, 'name the label (:ConfigurationItem for CIs) or use matchById from @opengraphity/types').toEqual([])
    for (const [file, allowed] of Object.entries(ALLOWED)) {
      expect(perFile.get(file) ?? 0, `${file}: ${allowed.reason}`).toBe(allowed.count)
    }
  })
})
