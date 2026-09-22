/**
 * lib/enumValueUsage.ts — the tolerant edges of counting and renaming a
 * vocabulary value, which enumValueUsage.test.ts does not reach.
 *
 * Why these matter for an admin editing the Dictionary:
 *  - configuration is written by people and by older versions of the product:
 *    a corrupt JSON, an action without params, a condition with a numeric value
 *    or a list with non-string entries must be SKIPPED, never crash the count
 *    (a crash would block every change to that vocabulary) and never be
 *    rewritten (a rename must not touch what it does not understand);
 *  - a value is "in use" only for the vocabulary that governs that field: a
 *    `category` action is not a use of `priority`, `status` is never a
 *    vocabulary value in an action, a placeholder like `{priority}` is resolved
 *    at run time and is not a value;
 *  - a rename rewrites only the nodes that actually cite the old value, and
 *    only in the caller's transaction, scoped by tenant;
 *  - records with a value no longer requested, or counted zero, add nothing.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../ciLifecycle.js', () => ({
  CI_STATUS_VOCABULARY: 'ci_status',
  lifecyclePolicyReferences: vi.fn(async () => []),
}))

const { countEnumValueUsage, replaceEnumValue } = await import('../enumValueUsage.js')

type Row = Record<string, unknown>
const rec = (m: Row) => ({ keys: Object.keys(m), get: (k: string) => (k in m ? m[k] : null) })

type Route = [(cypher: string) => boolean, Row[]]
const at = (label: string, property: string) => (c: string) =>
  (c.includes(`(n:${label} {tenant_id`) || c.includes(`(n:${label} {id: $tenantId`)) && c.includes(`n.${property}`)

/**
 * A fake graph answering by query shape. Reads go through `executeRead` when
 * given a session, straight through `run` when given the caller's transaction;
 * every SET is recorded as a write.
 */
function fakeGraph(routes: Route[]) {
  const writes: Array<{ cypher: string; params: Row }> = []
  const reads: Array<{ cypher: string; params: Row }> = []
  const run = vi.fn(async (cypher: string, params: Row = {}) => {
    if (/\bSET\b/.test(cypher)) { writes.push({ cypher, params }); return { records: [rec({ n: 1 })] } }
    reads.push({ cypher, params })
    const hit = routes.find(([p]) => p(cypher))
    return { records: (hit ? hit[1] : []).map(rec) }
  })
  const tx = { run }
  const session = { executeRead: (fn: (t: typeof tx) => unknown) => fn(tx) }
  return { tx, session, writes, reads }
}

const usesEnum = (c: string) => c.includes('USES_ENUM')
const matrix = (c: string) => c.includes('DomainMatrix')
const policy = (c: string) => c.includes('event_policy AS raw')

describe('countEnumValueUsage — what is and is not a use', () => {
  it('ignores values not asked for and zero counts; a corrupt matrix is skipped, a valid one counts', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [(c) => c.includes('(n:Incident {tenant_id') && c.includes('IN $values'), [{ value: 'high', n: 3 }, { value: 'other', n: 7 }, { value: 'low', n: 0 }]],
      [matrix, [{ kind: 'priority', entries: '{not json' }, { kind: 'change_priority', entries: JSON.stringify({ 'normal|low': 'high' }) }]],
    ])
    const out = await countEnumValueUsage(g.session as never, 't-1', 'priority', ['high', 'low'])
    // `low` has only a zero count: it is free to remove.
    expect(out.map((u) => u.value)).toEqual(['high'])
    const high = out[0]!
    expect(high.records).toEqual([{ typeName: 'Incident', fieldName: 'severity', count: 3 }])
    expect(high.matrices).toEqual(['change_priority (cell "normal|low")'])
    expect(high.total).toBe(4)
    // Every count reads only this tenant's nodes.
    expect(g.reads.filter((r) => r.cypher.includes('IN $values')).every((r) => r.params['tenantId'] === 't-1')).toBe(true)
  })

  it('actions: only writes of this vocabulary with a concrete, requested value count', async () => {
    const actions = JSON.stringify([
      null,
      'not an object',
      { type: 'set_priority' },                                         // no params
      { type: 'set_priority', params: 'x' },                           // params not an object
      { type: 'set_priority', params: { priority: '{priority}' } },    // placeholder
      { type: 'set_priority', params: { value: 'high' } },             // counts (legacy `value`)
      { type: 'set_priority', params: { priority: 'critical' } },      // not requested
      { type: 'set_field', params: { value: 'high' } },                // no field
      { type: 'set_field', params: { field: 'status', value: 'high' } }, // status is never a vocabulary value
      { type: 'set_field', params: { field: 'category', value: 'high' } }, // another vocabulary
      { type: 'update_field', params: { field: 'priority', value: 7 } }, // not a text value
      { type: 'notify', params: { priority: 'high' } },                // not a write
    ])
    const g = fakeGraph([
      [usesEnum, []],
      [at('BusinessRule', 'actions'), [{ raw: actions, name: 'Escalate' }]],
      // A list already parsed by the driver, an unreadable string, a JSON object, a null.
      [at('AutoTrigger', 'actions'), [
        { raw: [{ type: 'update_field', params: { field: 'priority', value: 'high' } }], name: null },
        { raw: 'nope', name: 'x' }, { raw: '{}', name: 'y' }, { raw: null, name: 'z' },
      ]],
    ])
    const [high] = await countEnumValueUsage(g.session as never, 't-1', 'priority', ['high'])
    expect(high!.configSites).toEqual(['the actions of a Business Rule «Escalate»', 'the actions of an Auto Trigger'])
  })

  it('a severity action counts for the severity vocabulary', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('WorkflowStep', 'enter_actions'), [{ raw: JSON.stringify([{ type: 'set_field', params: { field: 'severity', value: 'sev1' } }]), name: 'Triage' }]],
    ])
    const [u] = await countEnumValueUsage(g.session as never, 't-1', 'severity', ['sev1'])
    expect(u!.configSites).toEqual(['the entry actions of a workflow step «Triage»'])
  })

  it('step deadlines: malformed shapes are skipped, placeholders are not values', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('WorkflowStep', 'deadline'), [
        { raw: JSON.stringify({ set_fields: [null, 3, { field: 'priority', value: '{p}' }, { field: 'priority', value: '' }, { field: 'priority', value: 'high' }] }), name: 'Wait' },
        { raw: 'broken', name: 'a' }, { raw: 'null', name: 'b' }, { raw: JSON.stringify({ set_fields: 'x' }), name: 'c' }, { raw: null, name: 'd' },
      ]],
    ])
    const [u] = await countEnumValueUsage(g.session as never, 't-1', 'priority', ['high'])
    expect(u!.configSites).toEqual(['the fields set by a step deadline «Wait»'])
  })

  it('conditions: non-objects, numeric values and a status without entity type are ignored', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('BusinessRule', 'conditions'), [
        { raw: JSON.stringify([null, 'x', { field: 'status', value: 'new' }, { field: 'priority', value: 2 }]), entityType: null, name: 'R' },
        { raw: null, entityType: 'incident', name: 'S' },
        { raw: '{}', entityType: 'incident', name: 'T' },
      ]],
      [at('StandardChangeCatalogEntry', 'default_priority'), [{ value: 'medium', field: 'medium', name: 'Patch' }]],
    ])
    expect(await countEnumValueUsage(g.session as never, 't-1', 'status_incident', ['new'])).toEqual([])
  })

  it('a scalar site only counts requested values', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('ServiceCatalogItem', 'priority'), [{ value: 'medium', name: 'Laptop' }, { value: 'high', name: 'Phone' }]],
    ])
    const [u] = await countEnumValueUsage(g.session as never, 't-1', 'priority', ['high'])
    expect(u!.configSites).toEqual(['the priority of a service catalog item «Phone»'])
  })

  it('the pre-approved change types list counts, skipping non-string entries', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('Tenant', 'pre_approved_change_types'), [{ raw: ['standard', 5, 'normal'] }, { raw: 'not a list' }]],
    ])
    const [u] = await countEnumValueUsage(g.session as never, 't-1', 'change_type', ['standard'])
    expect(u!.configSites).toEqual(['the pre-approved change types'])
    // The Tenant is matched by id, not by a `tenant_id` it does not carry (C-25).
    expect(g.reads.find((r) => r.cypher.includes('pre_approved_change_types'))!.cypher).toContain('MATCH (n:Tenant {id: $tenantId})')
  })

  it('portal severity options: malformed lists and entries are skipped', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('Tenant', 'portal_severity_options'), [
        { raw: JSON.stringify([null, { label: 'x' }, { value: 'sev1', label: 'Critical' }]) },
        { raw: 'oops' }, { raw: '{"value":"sev1"}' }, { raw: null },
      ]],
    ])
    const [u] = await countEnumValueUsage(g.session as never, 't-1', 'severity', ['sev1'])
    expect(u!.configSites).toEqual(['the severities offered in the self-service portal'])
  })
})

describe('replaceEnumValue — rewrites only what cites the old value', () => {
  it('a corrupt or non-object alarm policy is left alone', async () => {
    for (const raw of ['{broken', '[1,2]', 'null']) {
      const g = fakeGraph([[usesEnum, []], [policy, [{ raw }]]])
      await replaceEnumValue(g.tx as never, 't-1', 'impact', 'high', 'major')
      expect(g.writes.filter((w) => w.cypher.includes('event_policy'))).toEqual([])
    }
  })

  it('the severity map: only object entries citing the value are rewritten', async () => {
    const raw = JSON.stringify({ severity_map: { critical: { impact: 'high', urgency: 'high' }, info: null, warn: ['x'], minor: { impact: 'low' } } })
    const g = fakeGraph([[usesEnum, []], [policy, [{ raw }]]])
    await replaceEnumValue(g.tx as never, 't-1', 'impact', 'high', 'major')
    const w = g.writes.find((x) => x.cypher.includes('event_policy'))!
    expect(JSON.parse(String(w.params['policy']))).toEqual({ severity_map: { critical: { impact: 'major', urgency: 'high' }, info: null, warn: ['x'], minor: { impact: 'low' } } })
    expect(w.params['tenantId']).toBe('t-1')
  })

  it('a corrupt matrix is skipped, not rewritten', async () => {
    const g = fakeGraph([[usesEnum, []], [matrix, [{ kind: 'priority', entries: 'nope' }]]])
    await replaceEnumValue(g.tx as never, 't-1', 'impact', 'high', 'major')
    expect(g.writes.filter((w) => w.cypher.includes('DomainMatrix'))).toEqual([])
  })

  it('conditions: an empty or unrelated list is not rewritten', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('BusinessRule', 'conditions'), [
        { id: 'r1', raw: '[]', entityType: 'incident' },
        { id: 'r2', raw: JSON.stringify([{ field: 'priority', value: 'low' }, { field: 'category', value: 'high' }]), entityType: 'incident' },
      ]],
    ])
    await replaceEnumValue(g.tx as never, 't-1', 'priority', 'high', 'p1')
    expect(g.writes.filter((w) => w.cypher.includes('n.conditions'))).toEqual([])
  })

  it('actions: set_priority rewrites both legacy and current keys; set_field its value; unrelated lists stay', async () => {
    const actions = [
      { type: 'set_priority', params: { priority: 'high', value: 'high' } },
      { type: 'set_priority', params: { priority: 'high', value: 3 } },
      { type: 'update_field', params: { field: 'priority', value: 'high', note: 'keep' } },
      { type: 'set_field', params: { field: 'category', value: 'high' } },
      { type: 'notify', params: {} },
    ]
    const g = fakeGraph([
      [usesEnum, []],
      [at('BusinessRule', 'actions'), [
        { id: 'b1', raw: JSON.stringify(actions) },
        { id: 'b2', raw: JSON.stringify([{ type: 'set_priority', params: { priority: 'low' } }]) },
        { id: 'b3', raw: 'broken' }, { id: 'b4', raw: '{}' },
      ]],
    ])
    await replaceEnumValue(g.tx as never, 't-1', 'priority', 'high', 'p1')
    const w = g.writes.filter((x) => x.cypher.includes('n.actions'))
    expect(w.map((x) => x.params['id'])).toEqual(['b1'])
    expect(JSON.parse(String(w[0]!.params['raw']))).toEqual([
      { type: 'set_priority', params: { priority: 'p1', value: 'p1' } },
      { type: 'set_priority', params: { priority: 'p1', value: 3 } },
      { type: 'update_field', params: { field: 'priority', value: 'p1', note: 'keep' } },
      { type: 'set_field', params: { field: 'category', value: 'high' } },
      { type: 'notify', params: {} },
    ])
    expect(w[0]!.cypher).toContain('MATCH (n:BusinessRule {id: $id, tenant_id: $tenantId})')
  })

  it('deadlines: only the fields of this vocabulary with the old value change', async () => {
    const deadline = { after: 2, unit: 'h', set_fields: [null, { field: 7, value: 'high' }, { field: 'priority', value: 'low' }, { field: 'category', value: 'high' }, { field: 'priority', value: 'high' }] }
    const g = fakeGraph([
      [usesEnum, []],
      [at('WorkflowStep', 'deadline'), [
        { id: 's1', raw: JSON.stringify(deadline) },
        { id: 's2', raw: 'nope' }, { id: 's3', raw: 'null' }, { id: 's4', raw: '{"set_fields":{}}' },
        { id: 's5', raw: JSON.stringify({ set_fields: [{ field: 'priority', value: 'low' }] }) },
      ]],
    ])
    await replaceEnumValue(g.tx as never, 't-1', 'priority', 'high', 'p1')
    const w = g.writes.filter((x) => x.cypher.includes('n.deadline'))
    expect(w.map((x) => x.params['id'])).toEqual(['s1'])
    expect(JSON.parse(String(w[0]!.params['raw'])).set_fields).toEqual([null, { field: 7, value: 'high' }, { field: 'priority', value: 'low' }, { field: 'category', value: 'high' }, { field: 'priority', value: 'p1' }])
  })

  it('the pre-approved change types are rewritten without duplicates; a list without the value is not', async () => {
    const g = fakeGraph([
      [usesEnum, []],
      [at('Tenant', 'pre_approved_change_types'), [{ raw: ['standard', 'routine', 3] }]],
    ])
    await replaceEnumValue(g.tx as never, 't-1', 'change_type', 'standard', 'routine')
    const w = g.writes.filter((x) => x.cypher.includes('pre_approved_change_types'))
    expect(w).toHaveLength(1)
    expect(w[0]!.params['list']).toEqual(['routine'])

    const g2 = fakeGraph([[usesEnum, []], [at('Tenant', 'pre_approved_change_types'), [{ raw: ['normal'] }]]])
    await replaceEnumValue(g2.tx as never, 't-1', 'change_type', 'standard', 'routine')
    expect(g2.writes.filter((x) => x.cypher.includes('pre_approved_change_types'))).toEqual([])
  })

  it('risk band thresholds that do not cite the value are not rewritten', async () => {
    const g = fakeGraph([[usesEnum, []], [at('Tenant', 'risk_band_thresholds'), [{ raw: JSON.stringify([{ band: 'low', upTo: 3 }]) }]]])
    await replaceEnumValue(g.tx as never, 't-1', 'risk_band', 'high', 'severe')
    expect(g.writes.filter((x) => x.cypher.includes('risk_band_thresholds'))).toEqual([])
  })
})
