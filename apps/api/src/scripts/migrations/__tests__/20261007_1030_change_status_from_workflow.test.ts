/**
 * Migration 20261007_1030: every change gets the status of its workflow step.
 *
 * What matters: only changes WITHOUT a status are touched (a status written by
 * the workflow is never overwritten), the value is the instance's current
 * step, and the work runs in batches (a tenant may have tens of thousands of
 * changes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { changeStatusFromWorkflow } = await import('../20261007_1030_change_status_from_workflow.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

function session(updated: number) {
  const calls: Array<{ cypher: string }> = []
  const run = vi.fn(async (cypher: string) => {
    calls.push({ cypher })
    return { records: [{ get: () => updated }] }
  })
  return { session: { run }, calls }
}

describe('20261007_1030_change_status_from_workflow', () => {
  it('is registered right after 20261007_1020', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261007_1030_change_status_from_workflow'))
      .toBe(ids.indexOf('20261007_1020_certificates_on_databases') + 1)
  })

  it('writes the current step only on the changes that have no status, in batches', async () => {
    const { session: s, calls } = session(177)
    await changeStatusFromWorkflow.up(s as never)
    expect(calls).toHaveLength(1)
    const q = calls[0]!.cypher
    expect(q).toContain('MATCH (c:Change)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)')
    expect(q).toContain('WHERE c.status IS NULL AND wi.current_step IS NOT NULL')
    expect(q).toContain('SET c.status = wi.current_step')
    expect(q).toContain('IN TRANSACTIONS OF 1000 ROWS')
    expect(lines).toEqual(['[20261007_1030_change_status_from_workflow] status written on 177 changes'])
  })

  it('says so when there is nothing to do', async () => {
    const { session: s } = session(0)
    await changeStatusFromWorkflow.up(s as never)
    expect(lines).toEqual(['[20261007_1030_change_status_from_workflow] every change already has a status'])
  })
})
