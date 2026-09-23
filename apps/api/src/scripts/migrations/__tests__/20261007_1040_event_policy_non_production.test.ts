/**
 * Migration 20261007_1040: the two keys of the severity outside production
 * reach the policies that lack them, switched OFF — the day it runs no
 * incident changes priority.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { eventPolicyNonProduction } = await import('../20261007_1040_event_policy_non_production.js')
const { MIGRATIONS } = await import('../index.js')
const { DEFAULT_EVENT_POLICY, parseEventPolicy } = await import('../../../lib/eventPolicy.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

/** A policy as the 1050 left it: everything up to high_impact_dependents. */
function policyBefore(): Record<string, unknown> {
  const p: Record<string, unknown> = { ...DEFAULT_EVENT_POLICY }
  for (const k of ['production_environments', 'non_production_severity_map']) delete p[k]
  return p
}

function session(policies: Array<{ id: string; policy: string }>) {
  const writes: Array<{ tenantId: string; policy: Record<string, unknown> }> = []
  const run = vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('RETURN t.id AS id, t.event_policy AS policy')) {
      return { records: policies.map((p) => ({ get: (k: string) => (k === 'id' ? p.id : p.policy) })) }
    }
    writes.push({ tenantId: String(params!['tenantId']), policy: JSON.parse(String(params!['policy'])) as Record<string, unknown> })
    return { records: [] }
  })
  return { session: { run }, writes }
}

describe('20261007_1040_event_policy_non_production', () => {
  it('is registered right after 20261007_1030', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261007_1040_event_policy_non_production'))
      .toBe(ids.indexOf('20261007_1030_change_status_from_workflow') + 1)
  })

  it('adds the two keys switched off: production is «production», the same map everywhere', async () => {
    const { session: s, writes } = session([{ id: 't1', policy: JSON.stringify(policyBefore()) }])
    await eventPolicyNonProduction.up(s as never)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.policy).toMatchObject({ production_environments: ['production'], non_production_severity_map: null })
    // the result is a valid policy of today
    expect(() => parseEventPolicy(JSON.stringify(writes[0]!.policy), 't1')).not.toThrow()
    expect(lines).toEqual(['[20261007_1040_event_policy_non_production] event_policy: 1 completed, 0 already had production_environments, non_production_severity_map'])
  })

  it('leaves a complete policy alone, and never overwrites a value the tenant chose', async () => {
    const chosen = { ...policyBefore(), production_environments: ['prod', 'dr'] }
    const { session: s, writes } = session([
      { id: 't1', policy: JSON.stringify(DEFAULT_EVENT_POLICY) },
      { id: 't2', policy: JSON.stringify(chosen) },
    ])
    await eventPolicyNonProduction.up(s as never)
    expect(writes.map((w) => w.tenantId)).toEqual(['t2'])
    expect(writes[0]!.policy['production_environments']).toEqual(['prod', 'dr'])
    expect(writes[0]!.policy['non_production_severity_map']).toBeNull()
  })

  it('a corrupt policy stops the migration with the tenant named', async () => {
    const { session: s } = session([{ id: 't9', policy: '{nope' }])
    await expect(eventPolicyNonProduction.up(s as never)).rejects.toThrow(/Tenant t9 event_policy is corrupt JSON/)
  })
})
