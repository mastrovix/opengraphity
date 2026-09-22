/**
 * Customer copies of a dictionary that add nothing over the shipped one.
 *
 * A copy wins by name and the product never touches it again, so a redundant
 * copy silently falls behind at the first value the product ships. The
 * diagnostic that finds them must be exact: flag a copy only when values (in
 * the same order, since that is the dropdown order), the dictionary label and
 * the per-value labels/colours all match. Flagging a copy that differs would
 * push an admin to delete real customisation; never flagging (the bug found on
 * c-one, where map key order made identical copies look different) means the
 * rule can never fire.
 */
import { describe, expect, it, vi } from 'vitest'

let rows: Array<Record<string, unknown>> = []
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(async () => rows) }))

const { vocabulariesCopiedWithoutChanges, vocabulariesBehindShipped, stessaMappa } = await import('../vocabularyShippedDrift.js')
const { runQuery } = await import('@opengraphity/neo4j')

const identical = {
  id: 'c-1', name: 'priority', label: 'Priority', shippedLabel: 'Priority',
  values: ['low', 'high'], shippedValues: ['low', 'high'],
  labels: '{"low":"Low","high":"High"}', shippedLabels: '{"high":"High","low":"Low"}',
  colors: null, shippedColors: '{}',
}

describe('vocabulariesCopiedWithoutChanges', () => {
  it('flags a copy identical in everything, even with keys in another order', async () => {
    rows = [identical]
    await expect(vocabulariesCopiedWithoutChanges({} as never, 'c-one'))
      .resolves.toEqual([{ id: 'c-1', name: 'priority', label: 'Priority' }])
    // Tenant scoping: the copy is the tenant's, the reference is the shared 'system' one.
    const [, cypher, params] = vi.mocked(runQuery).mock.calls.at(-1)!
    expect(cypher).toMatch(/MATCH \(c:EnumTypeDefinition \{tenant_id: \$tenantId\}\)/)
    expect(cypher).toMatch(/tenant_id: 'system', name: c\.name/)
    expect(params).toEqual({ tenantId: 'c-one' })
  })

  it.each([
    ['a different value order (the dropdown order is customisation)', { values: ['high', 'low'] }],
    ['an extra value', { values: ['low', 'high', 'critical'] }],
    ['a renamed dictionary label', { label: 'Urgency' }],
    ['a different per-value label', { labels: '{"low":"Bassa","high":"High"}' }],
    ['a per-value colour', { colors: { low: 'green' } }],
  ])('leaves alone a copy with %s', async (_why, patch) => {
    rows = [{ ...identical, ...patch }]
    await expect(vocabulariesCopiedWithoutChanges({} as never, 'c-one')).resolves.toEqual([])
  })

  it('treats a missing label on both sides as equal', async () => {
    rows = [{ ...identical, label: null, shippedLabel: null }]
    await expect(vocabulariesCopiedWithoutChanges({} as never, 'c-one')).resolves.toHaveLength(1)
  })

  it('a copy with no values against a shipped list with none is identical', async () => {
    rows = [{ ...identical, values: null, shippedValues: null }]
    await expect(vocabulariesCopiedWithoutChanges({} as never, 'c-one')).resolves.toHaveLength(1)
  })

  it('a corrupt values property is an error naming the dictionary, not a silent skip', async () => {
    rows = [{ ...identical, shippedValues: [1, 2] }]
    await expect(vocabulariesCopiedWithoutChanges({} as never, 'c-one')).rejects.toThrow(/Shipped dictionary "priority": values/)
  })
})

describe('vocabulariesBehindShipped — seen list', () => {
  it('a corrupt shipped_values_seen is an error naming the dictionary', async () => {
    rows = [{ id: 'c-1', name: 'impact', values: ['a'], seen: 'a,b', shipped: ['a', 'b'] }]
    await expect(vocabulariesBehindShipped({} as never, 'c-one')).rejects.toThrow(/Dictionary "impact": shipped_values_seen/)
  })

  it('a seen list suppresses values the admin already decided on', async () => {
    rows = [{ id: 'c-1', name: 'impact', values: ['a'], seen: ['a', 'b'], shipped: ['a', 'b', 'c'] }]
    await expect(vocabulariesBehindShipped({} as never, 'c-one'))
      .resolves.toEqual([{ id: 'c-1', name: 'impact', newValues: ['c'] }])
  })
})

describe('stessaMappa — already-parsed maps', () => {
  it('compares an object against its JSON string form', () => {
    expect(stessaMappa({ a: 'x' }, '{"a":"x"}')).toBe(true)
    expect(stessaMappa({ a: 'x' }, { a: 'y' })).toBe(false)
  })
})
