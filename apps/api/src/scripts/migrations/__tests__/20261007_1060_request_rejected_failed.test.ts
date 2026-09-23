/**
 * Migration 20261007_1060: the factory step «rejected» of the request
 * workflows gets category `failed`, like the rejection of a problem.
 *
 * What matters: only the service-request workflows, only the factory name,
 * only where the category is still the factory `closed` (a category the
 * customer chose is kept), and it says what it changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { requestRejectedFailed } = await import('../20261007_1060_request_rejected_failed.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

describe('20261007_1060_request_rejected_failed', () => {
  it('is registered right after 20261007_1050', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261007_1060_request_rejected_failed'))
      .toBe(ids.indexOf('20261007_1050_isolated_cluster_every_relation') + 1)
  })

  it('moves only the factory step that still has the factory category, and names each one', async () => {
    const rows = [{ tenant: 'c-one', definition: 'Service Request Fulfillment' }, { tenant: 'c-two', definition: 'Service Request Fulfillment' }]
    const run = vi.fn(async (_cypher: string) => ({ records: rows.map((r) => ({ get: (k: string) => r[k as keyof typeof r] })) }))
    await requestRejectedFailed.up({ run } as never)
    const q = String(run.mock.calls[0]![0])
    expect(q).toContain("MATCH (wd:WorkflowDefinition {entity_type: 'service_request'})-[:HAS_STEP]->(s:WorkflowStep {name: 'rejected'})")
    expect(q).toContain("WHERE s.category = 'closed' AND coalesce(s.is_terminal, false) = true")
    expect(q).toContain("SET s.category = 'failed'")
    expect(lines).toContain('[20261007_1060_request_rejected_failed] c-one / "Service Request Fulfillment" / rejected → category "failed"')
    expect(lines.at(-1)).toBe('[20261007_1060_request_rejected_failed] 2 steps moved to "failed"')
  })
})
