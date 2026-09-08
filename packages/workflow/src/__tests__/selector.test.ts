import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'

process.env['LOG_LEVEL'] = 'silent'
const { selectWorkflowForEntity } = await import('../selector.js')

// ── Session mock: three query shapes, each scripted independently ────────────

type Row = { id: string; name: string; category: string | null; priority?: number }
type Shape = 'subtype+category' | 'subtype-no-category' | 'generic'

function shapeOf(cypher: string): Shape {
  if (cypher.includes('change_subtype: $changeSubtype')) {
    return cypher.includes('wd.category IS NULL') ? 'subtype-no-category' : 'subtype+category'
  }
  return 'generic'
}

let answers: Partial<Record<Shape, Row[]>> = {}
const queries: Array<{ shape: Shape; cypher: string; params: Record<string, unknown> }> = []

const session = {
  executeRead: async (work: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }> }) => Promise<unknown>) =>
    work({
      run: async (cypher, params) => {
        const shape = shapeOf(cypher)
        queries.push({ shape, cypher, params })
        const rows = answers[shape] ?? []
        return { records: rows.map(r => ({ get: (k: string) => (r as Record<string, unknown>)[k] })) }
      },
    }),
} as unknown as Session

beforeEach(() => {
  answers = {}
  queries.length = 0
})

describe('selectWorkflowForEntity — generic entities', () => {
  it('no active definition for (tenant, entity_type) → null (pinned: no throw; the caller decides)', async () => {
    const r = await selectWorkflowForEntity(session, 't1', 'incident', 'database')
    expect(r).toBeNull()
    expect(queries).toHaveLength(1)
    expect(queries[0]!.shape).toBe('generic')
    expect(queries[0]!.params).toEqual({ tenantId: 't1', entityType: 'incident', category: 'database' })
  })

  it('one query, scoped to the tenant and active definitions; deterministic rule: category match (0) before default (1), then highest version', async () => {
    answers = { generic: [{ id: 'def-cat', name: 'Incident DB', category: 'database', priority: 0 }] }
    const r = await selectWorkflowForEntity(session, 't1', 'incident', 'database')
    expect(r).toEqual({ definitionId: 'def-cat', name: 'Incident DB', category: 'database' })

    const c = queries[0]!.cypher
    expect(c).toContain('tenant_id:   $tenantId')
    expect(c).toContain('entity_type: $entityType')
    expect(c).toContain('active:      true')
    expect(c).toContain('WHEN wd.category IS NOT NULL AND wd.category = $category THEN 0')
    expect(c).toContain('WHEN wd.category IS NULL THEN 1')
    expect(c).toContain('WHERE priority < 2')          // a definition of ANOTHER category is never picked
    expect(c).toContain('ORDER BY priority ASC, wd.version DESC')
    expect(c).toContain('LIMIT 1')
  })

  it('category null → the default (category IS NULL) definition is the only candidate; param is null', async () => {
    answers = { generic: [{ id: 'def-default', name: 'Incident default', category: null, priority: 1 }] }
    const r = await selectWorkflowForEntity(session, 't1', 'incident', null)
    expect(r).toEqual({ definitionId: 'def-default', name: 'Incident default', category: null })
    expect(queries[0]!.params['category']).toBeNull()
  })

  it('a changeSubtype on a non-change entity is ignored (no subtype queries)', async () => {
    answers = { generic: [{ id: 'd', name: 'n', category: null }] }
    await selectWorkflowForEntity(session, 't1', 'problem', null, 'standard')
    expect(queries.map(q => q.shape)).toEqual(['generic'])
  })

  it('change without subtype → generic logic only', async () => {
    await selectWorkflowForEntity(session, 't1', 'change', 'network')
    expect(queries.map(q => q.shape)).toEqual(['generic'])
    await selectWorkflowForEntity(session, 't1', 'change', 'network', null)
    expect(queries.map(q => q.shape)).toEqual(['generic', 'generic'])
  })
})

describe('selectWorkflowForEntity — change with subtype (3-tier fallback)', () => {
  it('tier 1: subtype + category match → returned without further queries', async () => {
    answers = { 'subtype+category': [{ id: 'def-emg-net', name: 'Emergency Network', category: 'network' }] }
    const r = await selectWorkflowForEntity(session, 't1', 'change', 'network', 'emergency')
    expect(r).toEqual({ definitionId: 'def-emg-net', name: 'Emergency Network', category: 'network' })
    expect(queries.map(q => q.shape)).toEqual(['subtype+category'])
    const q = queries[0]!
    expect(q.params).toEqual({ tenantId: 't1', changeSubtype: 'emergency', category: 'network' })
    expect(q.cypher).toContain("entity_type:    'change'")
    expect(q.cypher).toContain('active:         true')
    expect(q.cypher).toContain('ORDER BY wd.version DESC')
    expect(q.cypher).toContain('LIMIT 1')
  })

  it('tier 2: subtype with category IS NULL when no category-specific one exists', async () => {
    answers = { 'subtype-no-category': [{ id: 'def-emg', name: 'Emergency', category: null }] }
    const r = await selectWorkflowForEntity(session, 't1', 'change', 'network', 'emergency')
    expect(r).toEqual({ definitionId: 'def-emg', name: 'Emergency', category: null })
    expect(queries.map(q => q.shape)).toEqual(['subtype+category', 'subtype-no-category'])
    expect(queries[1]!.params).toEqual({ tenantId: 't1', changeSubtype: 'emergency' })
  })

  it('tier 3: no subtype-specific definition → generic change logic (category, then default)', async () => {
    answers = { generic: [{ id: 'def-change', name: 'Change default', category: null }] }
    const r = await selectWorkflowForEntity(session, 't1', 'change', 'network', 'emergency')
    expect(r).toEqual({ definitionId: 'def-change', name: 'Change default', category: null })
    expect(queries.map(q => q.shape)).toEqual(['subtype+category', 'subtype-no-category', 'generic'])
    expect(queries[2]!.params).toEqual({ tenantId: 't1', entityType: 'change', category: 'network' })
  })

  it('nothing at any tier → null after all three queries', async () => {
    expect(await selectWorkflowForEntity(session, 't1', 'change', null, 'standard')).toBeNull()
    expect(queries).toHaveLength(3)
    expect(queries[0]!.params['category']).toBeNull()
  })

  it('tier 1 requires a NON-NULL category equal to the requested one (a null category never matches tier 1)', async () => {
    await selectWorkflowForEntity(session, 't1', 'change', null, 'standard')
    expect(queries[0]!.cypher).toContain('WHERE wd.category IS NOT NULL AND wd.category = $category')
  })

  it('a read error propagates unchanged', async () => {
    const broken = { executeRead: async () => { throw new Error('neo4j unavailable') } } as unknown as Session
    await expect(selectWorkflowForEntity(broken, 't1', 'incident', null)).rejects.toThrow('neo4j unavailable')
  })
})
