/**
 * lib/tenantNodes.ts — the nodes of one tenant, label by label (review of
 * 23 Sep 2026): the unlabelled `MATCH (n {tenant_id})` scanned every
 * customer's nodes, and with IN TRANSACTIONS it made Neo4j fall on the demo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: Array<{ q: string; p: Record<string, unknown>; inMaintenance: boolean }> = []
const counts: Record<string, number> = {}
// The maintenance scope, recorded (wave 7 · A2): each deletion must run inside it.
const scope = vi.hoisted(() => ({ depth: 0 }))
vi.mock('@opengraphity/neo4j', () => ({
  MAINTENANCE_SCOPE: { readTimeoutMs: 7_200_000, writeTimeoutMs: 7_200_000 },
  runInQueryScope: async (_s: unknown, fn: () => Promise<unknown>) => {
    scope.depth++
    try { return await fn() } finally { scope.depth-- }
  },
  runQuery: vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => {
    calls.push({ q, p, inMaintenance: scope.depth > 0 })
    if (q.includes('CALL db.labels()')) return [{ label: 'Incident' }, { label: 'User' }, { label: 'We`ird' }]
    const label = /MATCH \(n:`((?:[^`]|``)+)`/.exec(q)?.[1]?.replace(/``/g, '`') ?? ''
    return [{ n: counts[label] ?? 0 }]
  }),
  toNumber: (v: unknown) => Number(v ?? 0),
}))

const { countTenantNodesByLabel, deleteTenantNodes } = await import('../tenantNodes.js')

beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(counts)) delete counts[k]
})

describe('countTenantNodesByLabel', () => {
  it('one labelled count per label of the database, the empty ones left out', async () => {
    counts['Incident'] = 12; counts['User'] = 3
    await expect(countTenantNodesByLabel({} as never, 'acme')).resolves.toEqual({ Incident: 12, User: 3 })
    const reads = calls.filter((c) => c.q.includes('count(n)'))
    expect(reads.map((c) => c.q)).toEqual([
      'MATCH (n:`Incident` {tenant_id: $tenantId}) RETURN count(n) AS n',
      'MATCH (n:`User` {tenant_id: $tenantId}) RETURN count(n) AS n',
      'MATCH (n:`We``ird` {tenant_id: $tenantId}) RETURN count(n) AS n',
    ])
    expect(reads.every((c) => c.p['tenantId'] === 'acme')).toBe(true)
  })
})

describe('deleteTenantNodes', () => {
  it('deletes label by label, in transactions of a thousand rows, and never without a label', async () => {
    counts['Incident'] = 12; counts['User'] = 3
    await expect(deleteTenantNodes({} as never, 'acme')).resolves.toBe(15)
    const deletes = calls.filter((c) => c.q.includes('DETACH DELETE'))
    expect(deletes).toHaveLength(3)
    for (const d of deletes) {
      expect(d.q).toMatch(/MATCH \(n:`[^{]+` \{tenant_id: \$tenantId\}\)/)
      expect(d.q).toContain('IN TRANSACTIONS OF 1000 ROWS')
      expect(d.p).toEqual({ tenantId: 'acme' })
      // The console's purge is a request, and the outer transaction lasts the whole label: the maintenance limit.
      expect(d.inMaintenance).toBe(true)
    }
    expect(calls.some((c) => c.q.includes('MATCH (n {'))).toBe(false)
  })
})
