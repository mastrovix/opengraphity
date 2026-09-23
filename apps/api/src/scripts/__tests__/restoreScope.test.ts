/**
 * RESTORING ONE TENANT (review of 23 Sep 2026).
 *
 * What these tests pin: a tenant archive is restored only with its own
 * `--tenant`, an installation archive never with one, and a tenant archive
 * holding a node of another tenant is refused before anything is written.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const writes: Array<{ cypher: string; rows: unknown }> = []
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeWrite: async (fn: (tx: unknown) => unknown) => fn({
      run: async (cypher: string, p: { rows: unknown[] }) => {
        writes.push({ cypher, rows: p.rows })
        return { records: [{ get: () => (p.rows as Array<{ k?: number }>).reduce((x, r) => x + (r.k ?? 1), 0) }] }
      },
    }),
    close: async () => {},
  })),
}))

const { scopeMismatch, foreignNodesInTenantArchive, restorePlan, createRestoreIndexes, cleanUpRestore, restoreNodes, restoreRelations, RESTORE_EID } = await import('../restore-neo4j.js')

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'og-restore-scope-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('scopeMismatch', () => {
  it('the same scope is fine', () => {
    expect(scopeMismatch(null, null)).toBeNull()
    expect(scopeMismatch('acme', 'acme')).toBeNull()
  })

  it('every other combination says what to do', () => {
    expect(scopeMismatch(null, 'acme')).toMatch(/whole installation: restore it without --tenant/)
    expect(scopeMismatch('acme', null)).toMatch(/tenant "acme": restore it with --tenant acme/)
    expect(scopeMismatch('acme', 'globex')).toMatch(/tenant "acme", not of "globex"/)
  })
})

describe('foreignNodesInTenantArchive', () => {
  const row = (labels: string[], props: Record<string, unknown>) => JSON.stringify({ id: `4:x:${String(props['id'])}`, labels, props })

  it('the tenant\'s nodes, its Tenant node and the system nodes are its own', async () => {
    const f = join(dir, 'own.jsonl')
    await writeFile(f, [
      row(['Incident'], { id: 'i1', tenant_id: 'acme' }),
      row(['Tenant'], { id: 'acme' }),
      row(['EnumTypeDefinition'], { id: 'e1', tenant_id: 'system' }),
    ].join('\n'))
    await expect(foreignNodesInTenantArchive(f, 'acme')).resolves.toEqual({ count: 0, sample: [] })
  })

  it('another tenant\'s node, another Tenant node or a node without an owner are foreign, named', async () => {
    const f = join(dir, 'foreign.jsonl')
    await writeFile(f, [
      row(['Incident'], { id: 'i1', tenant_id: 'acme' }),
      row(['Incident'], { id: 'i2', tenant_id: 'globex' }),
      row(['Tenant'], { id: 'globex' }),
      row(['Migration'], { id: 'm1' }),
    ].join('\n'))
    const out = await foreignNodesInTenantArchive(f, 'acme')
    expect(out.count).toBe(3)
    expect(out.sample).toEqual(['Incident "i2" (tenant_id "globex")', 'Tenant "globex" (tenant_id null)', 'Migration "m1" (tenant_id null)'])
  })
})

// ── The restore of a large graph finishes, and loses nothing (review of 23 Sep 2026) ──

const node = (id: string, labels: string[], props: Record<string, unknown>) => JSON.stringify({ id, labels, props })

describe('restorePlan', () => {
  it('splits the first labels into those found by id and those that need the archive elementId', async () => {
    const f = join(dir, 'plan.jsonl')
    await writeFile(f, [
      node('4:x:1', ['AuditEntry'], { id: 'a1' }),
      node('4:x:2', ['FormTableRow'], { tenant_id: 't' }),
      node('4:x:3', ['Counter'], { tenant_id: 't', kind: 'incident' }),
    ].join('\n'))
    const plan = await restorePlan(f)
    expect([...plan.byId]).toEqual(['AuditEntry'])
    expect([...plan.byEid].sort()).toEqual(['Counter', 'FormTableRow'])
  })
})

describe('temporary indexes', () => {
  const session = (indexed: string[]) => {
    const run = vi.fn(async (cypher: string) => cypher.startsWith('SHOW INDEXES')
      ? { records: indexed.map((l) => ({ get: () => l })) }
      : { records: [] })
    return { run, session: { run } as never }
  }

  it('an id index only where the schema has none; an elementId index for every label without id; waits until online', async () => {
    const { run, session: s } = session(['User'])
    const created = await createRestoreIndexes(s, { byId: new Set(['User', 'AuditEntry']), byEid: new Set(['FormTableRow']) })
    expect(created).toEqual(['og_restore_AuditEntry_id', 'og_restore_FormTableRow_restore_eid'])
    const cypher = run.mock.calls.map((c) => String(c[0]))
    expect(cypher).toContain('CREATE INDEX `og_restore_AuditEntry_id` IF NOT EXISTS FOR (n:AuditEntry) ON (n.id)')
    expect(cypher).toContain(`CREATE INDEX \`og_restore_FormTableRow_restore_eid\` IF NOT EXISTS FOR (n:FormTableRow) ON (n.${RESTORE_EID})`)
    expect(cypher.at(-1)).toBe('CALL db.awaitIndexes(600)')
  })

  it('cleaning up removes the markers in batches and drops only the restore\'s indexes', async () => {
    const { run, session: s } = session([])
    await cleanUpRestore(s, new Set(['FormTableRow']), ['og_restore_AuditEntry_id'])
    const cypher = run.mock.calls.map((c) => String(c[0]))
    expect(cypher[0]).toContain(`MATCH (n:FormTableRow) WHERE n.${RESTORE_EID} IS NOT NULL CALL (n) { REMOVE n.${RESTORE_EID} } IN TRANSACTIONS`)
    expect(cypher[1]).toBe('DROP INDEX `og_restore_AuditEntry_id` IF EXISTS')
    await expect(cleanUpRestore(s, new Set(), ['user_id_unique'])).rejects.toThrow('Not a restore index')
  })
})

describe('nodes and relationships without id', () => {
  beforeEach(() => { writes.length = 0 })

  it('a node without key is created once per archive elementId — never matched by its values', async () => {
    const f = join(dir, 'noid.jsonl')
    await writeFile(f, [node('4:x:7', ['FormTableRow'], { tenant_id: 't', quantity: 2 }), node('4:x:8', ['FormTableRow'], { tenant_id: 't', quantity: 2 })].join('\n'))
    await restoreNodes(f, false)
    expect(writes[0]!.cypher).toContain(`OPTIONAL MATCH (m:FormTableRow {${RESTORE_EID}: r.eid})`)
    expect(writes[0]!.cypher).not.toContain('properties(m) = r.props')
    expect(writes[0]!.rows).toEqual([{ props: { tenant_id: 't', quantity: 2 }, eid: '4:x:7' }, { props: { tenant_id: 't', quantity: 2 }, eid: '4:x:8' }])
  })

  it('a relationship to a node without id is found by the archive elementId, and is not skipped', async () => {
    const f = join(dir, 'noid-rels.jsonl')
    await writeFile(f, JSON.stringify({
      startId: '4:x:1', startLabels: ['ServiceRequest'], startProps: { id: 'sr1' },
      relType: 'FORM_TABLE_ROW', relProps: { row_index: 0 },
      endId: '4:x:7', endLabels: ['FormTableRow'], endProps: { tenant_id: 't' },
    }))
    const stats = await restoreRelations(f, false)
    expect(stats).toMatchObject({ total: 1, restored: 1, unmatched: 0, skippedNoId: [] })
    expect(writes[0]!.cypher).toContain(`MATCH (a:ServiceRequest {id: r.start}) MATCH (b:FormTableRow {${RESTORE_EID}: r.end})`)
    expect(writes[0]!.rows).toEqual([{ start: 'sr1', end: '4:x:7', relProps: { row_index: 0 }, k: 1 }])
  })

  // The first real restore: two TRANSITIONS_TO between the same steps (timer and manual) came back as one.
  it('parallel relationships survive: identity is ends, type and properties, written as many times as the archive has them', async () => {
    const f = join(dir, 'parallel-rels.jsonl')
    const tr = (props: Record<string, unknown>) => JSON.stringify({
      startId: '4:x:1', startLabels: ['WorkflowStep'], startProps: { id: 'resolved' },
      relType: 'TRANSITIONS_TO', relProps: props,
      endId: '4:x:2', endLabels: ['WorkflowStep'], endProps: { id: 'closed' },
    })
    await writeFile(f, [tr({ trigger: 'timer' }), tr({ trigger: 'manual' }), tr({ trigger: 'manual' })].join('\n'))
    const stats = await restoreRelations(f, false)
    expect(writes[0]!.cypher).not.toContain('MERGE')
    expect(writes[0]!.cypher).toContain('OPTIONAL MATCH (a)-[e:TRANSITIONS_TO]->(b) WHERE properties(e) = r.relProps')
    expect(writes[0]!.cypher).toContain('FOREACH (_ IN range(1, r.k - have) | CREATE (a)-[x:TRANSITIONS_TO]->(b) SET x = r.relProps)')
    expect(writes[0]!.rows).toEqual([
      { start: 'resolved', end: 'closed', relProps: { trigger: 'timer' }, k: 1 },
      { start: 'resolved', end: 'closed', relProps: { trigger: 'manual' }, k: 2 },
    ])
    expect(stats).toMatchObject({ total: 3, restored: 3, unmatched: 0 })
  })
})
