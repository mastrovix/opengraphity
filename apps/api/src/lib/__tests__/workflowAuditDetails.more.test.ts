/**
 * The workflow designer's Audit Log details — snapshot and diff edges.
 *
 * Why it matters: `workflow.updated` must say WHAT changed. The snapshot is
 * read inside the saving transaction and must stay scoped to the tenant (a
 * definition id from another tenant must not leak its steps into this log),
 * and the diff must neither invent changes (null vs missing) nor lose a step
 * that only exists after the save.
 * Note: the diff walks the AFTER snapshot only. The designer save
 * (workflowMutations.saveWorkflowChanges) edits steps and arcs but never
 * deletes them, so a step missing from AFTER cannot happen there today.
 */
import { describe, it, expect, vi } from 'vitest'
import { workflowSnapshot, workflowChangeDetails } from '../workflowAuditDetails.js'

function fakeTx(steps: Array<[string, Record<string, unknown>]>, transitions: Array<[string, Record<string, unknown>]>) {
  return {
    run: vi.fn(async (cypher: string) => {
      const rows = cypher.includes('TRANSITIONS_TO') ? transitions : steps
      return { records: rows.map(([name, props]) => ({ get: (k: string) => (k === 'name' ? name : props) })) }
    }),
  }
}

describe('workflowSnapshot', () => {
  it('reads steps and arcs of the definition in the caller tenant, keyed by name', async () => {
    const tx = fakeTx(
      [['new', { label: 'New', is_initial: true }], ['done', { label: 'Done', is_terminal: true }]],
      [['new → done', { label: 'Close', trigger: 'manual' }]],
    )
    const snap = await workflowSnapshot(tx as never, 't1', 'def-1')
    expect(snap).toEqual({
      steps: { new: { label: 'New', is_initial: true }, done: { label: 'Done', is_terminal: true } },
      transitions: { 'new → done': { label: 'Close', trigger: 'manual' } },
    })
    for (const call of tx.run.mock.calls) {
      expect(call[0]).toContain('{id: $definitionId, tenant_id: $tenantId}')
      expect(call[1]).toEqual({ definitionId: 'def-1', tenantId: 't1' })
    }
  })

  it('projects exactly the audited fields, so the diff compares like with like', async () => {
    const tx = fakeTx([], [])
    await workflowSnapshot(tx as never, 't1', 'def-1')
    const [stepQ, trQ] = tx.run.mock.calls.map((c) => c[0])
    expect(stepQ).toContain('.label, .category, .purpose, .enter_actions, .exit_actions, .is_initial, .is_terminal, .is_open, .deadline')
    expect(trQ).toContain('.label, .trigger, .requires_input, .input_field, .condition, .timer_hours')
  })
})

describe('workflowChangeDetails — edges of the diff', () => {
  it('a new step and a new arc show every set field as coming from null', () => {
    const d = workflowChangeDetails(
      { steps: {}, transitions: {} },
      { steps: { review: { label: 'Review', category: 'active' } }, transitions: { 'new → review': { trigger: 'manual' } } },
      3, 4,
    )
    expect(d['steps']).toEqual([{ step: 'review', changed: { label: { from: null, to: 'Review' }, category: { from: null, to: 'active' } } }])
    expect(d['transitions']).toEqual([{ transition: 'new → review', changed: { trigger: { from: null, to: 'manual' } } }])
  })

  it('undefined and null are the same "absent" value: no phantom change is logged', () => {
    const d = workflowChangeDetails(
      { steps: { a: { label: 'A', purpose: undefined } }, transitions: { x: { condition: null } } },
      { steps: { a: { label: 'A', purpose: null } }, transitions: { x: {} } },
      1, 1,
    )
    expect(d['steps']).toEqual([])
    expect(d['transitions']).toEqual([])
  })

  it('steps are listed in a stable, sorted order', () => {
    const d = workflowChangeDetails(
      { steps: {}, transitions: {} },
      { steps: { zeta: { label: 'Z' }, alpha: { label: 'A' } }, transitions: {} },
      1, 2,
    )
    expect((d['steps'] as Array<{ step: string }>).map((s) => s.step)).toEqual(['alpha', 'zeta'])
  })
})
