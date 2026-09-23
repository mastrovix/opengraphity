/**
 * Migration 20261007_1050: the isolated-cluster rules still exactly as seeded
 * move to the new seed (every relation, from the applications); a rule an
 * administrator changed is theirs and stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { isolatedClusterEveryRelation } = await import('../20261007_1050_isolated_cluster_every_relation.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

const SEEDED = {
  enabled: true, severity: 'medium', ciTypes: ['application', 'certificate'],
  relations: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'], threshold: 5, incidentSeverities: [], forbidden: [],
}

function session(rows: Array<{ tenantId: string; settings: string }>) {
  const writes: Array<{ tenantId: string; settings: Record<string, unknown> }> = []
  const run = vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('RETURN c.tenant_id AS tenantId')) {
      return { records: rows.map((r) => ({ get: (k: string) => (k === 'tenantId' ? r.tenantId : r.settings) })) }
    }
    writes.push({ tenantId: String(params!['tenantId']), settings: JSON.parse(String(params!['settings'])) as Record<string, unknown> })
    return { records: [] }
  })
  return { session: { run }, writes }
}

describe('20261007_1050_isolated_cluster_every_relation', () => {
  it('is registered right after 20261007_1040', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261007_1050_isolated_cluster_every_relation'))
      .toBe(ids.indexOf('20261007_1040_event_policy_non_production') + 1)
  })

  it('the seed as written (in any key order) moves; a rule the tenant changed stays', async () => {
    const reordered = JSON.stringify({ threshold: 5, relations: SEEDED.relations, ciTypes: SEEDED.ciTypes, severity: 'medium', enabled: true, forbidden: [], incidentSeverities: [] })
    const { session: s, writes } = session([
      { tenantId: 't1', settings: JSON.stringify(SEEDED) },
      { tenantId: 't2', settings: reordered },
      { tenantId: 't3', settings: JSON.stringify({ ...SEEDED, threshold: 8 }) },
      { tenantId: 't4', settings: JSON.stringify({ ...SEEDED, ciTypes: ['application'] }) },
      { tenantId: 't5', settings: 'not json' },
    ])
    await isolatedClusterEveryRelation.up(s as never)
    expect(writes.map((w) => w.tenantId)).toEqual(['t1', 't2'])
    expect(writes[0]!.settings).toMatchObject({ ciTypes: ['application'], relations: [], threshold: 5, severity: 'medium', enabled: true })
    expect(lines).toEqual(['[20261007_1050_isolated_cluster_every_relation] isolated_cluster: 2 moved to the new seed, 2 chosen by the tenant and kept; settings that are not JSON, left as they are (the anomaly scan reports them): t5'])
  })
})
