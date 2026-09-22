/**
 * Workflow helpers beyond the cache (lib/workflowHelpers.ts).
 *
 * Why these behaviours matter: every list, counter, automatic transition and
 * notification escalation asks these helpers "which steps are open / terminal
 * / concluded / have purpose X". The answers must come ONLY from the step
 * metadata of the tenant's own workflow, never from step names, and the
 * failure modes must be explicit:
 *  - no initial step, or no step with a required purpose, is an error — an
 *    empty list would silently switch off a domain rule;
 *  - an entity without a workflow instance is "not terminal / not closed /
 *    not concluded", never a crash;
 *  - a failed read is not cached, or one database timeout would be replayed
 *    to every caller of the tenant for 30 seconds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getTerminalStepNames, getOpenStepNames, getInitialStepName, getEntityCurrentStep, isEntityInTerminalStep,
  isEntityClosed, isEntityOpen, isEntityConcluded, getStepCategory, getWorkflowSteps, getStepNamesByClass,
  getStepNamesByPurpose, getStepRow, getStepPurpose, requireStepNamesByPurpose, invalidateWorkflowCache,
  TICKET_STATUS_CLASSES,
} from '../workflowHelpers.js'

type Row = Record<string, unknown>
function fakeSession(rows: Row[]) {
  const run = vi.fn(async (_cypher: string, _params: Record<string, unknown>) => ({
    records: rows.map((r) => ({ get: (k: string) => (k in r ? r[k] : null) })),
  }))
  return { run, executeRead: vi.fn(async (work: (tx: { run: typeof run }) => Promise<unknown>) => work({ run })) }
}
const S = (s: ReturnType<typeof fakeSession>) => s as never

const step = (name: string, over: Row = {}): Row => ({
  name, label: null, labels: null, isInitial: false, isTerminal: false, isOpen: true, category: 'active', purpose: null, stepOrder: 1, ...over,
})

/** A small incident workflow expressed only through metadata. */
const WORKFLOW = [
  step('new',        { isInitial: true, category: 'new', stepOrder: 1 }),
  step('working',    { category: 'active', purpose: 'implementation', stepOrder: 2 }),
  step('fixed',      { category: 'resolved', stepOrder: 3 }),
  step('done',       { isTerminal: true, isOpen: false, category: 'closed', purpose: 'closure', stepOrder: 4 }),
  step('cancelled',  { isTerminal: true, isOpen: false, category: 'closed', purpose: 'closure', stepOrder: null }),
]

beforeEach(() => { invalidateWorkflowCache() })

describe('step rows', () => {
  it('maps the stored metadata, with nulls for what the customer did not set', async () => {
    const s = fakeSession([step('a', { label: 'Alpha', stepOrder: '7', category: null }), step('b', { stepOrder: null })])
    const rows = await getWorkflowSteps(S(s), 't1', 'incident')
    expect(rows[0]).toEqual({
      name: 'a', label: 'Alpha', labels: [], isInitial: false, isTerminal: false, isOpen: true,
      category: null, purpose: null, stepOrder: 7,
    })
    expect(rows[1]!.stepOrder).toBeNull()
    // The read is scoped to the tenant and entity type: another tenant's designer never leaks in.
    expect(s.run.mock.calls[0]![1]).toEqual({ tenantId: 't1', entityType: 'incident' })
  })

  it('a failed read is not cached: the next call reads again', async () => {
    const bad = { executeRead: vi.fn().mockRejectedValue(new Error('timeout')) }
    await expect(getWorkflowSteps(bad as never, 't1', 'incident')).rejects.toThrow('timeout')
    const good = fakeSession([step('new')])
    await expect(getWorkflowSteps(S(good), 't1', 'incident')).resolves.toHaveLength(1)
    expect(good.run).toHaveBeenCalledOnce()
  })
})

describe('names by flag', () => {
  it('terminal and open step names come from the flags, not the names', async () => {
    const s = fakeSession(WORKFLOW)
    expect(await getTerminalStepNames(S(s), 't1', 'incident')).toEqual(['done', 'cancelled'])
    expect(await getOpenStepNames(S(s), 't1', 'incident')).toEqual(['new', 'working', 'fixed'])
  })

  it('the initial step is the one flagged initial', async () => {
    expect(await getInitialStepName(S(fakeSession(WORKFLOW)), 't1', 'incident')).toBe('new')
  })

  it('a workflow without an initial step is an error naming entity and tenant', async () => {
    await expect(getInitialStepName(S(fakeSession([step('x')])), 't1', 'problem'))
      .rejects.toThrow('No initial step defined for entityType "problem" in tenant "t1"')
  })
})

describe('single step lookups', () => {
  it('category, purpose and row of a named step; null when the step does not exist', async () => {
    const s = fakeSession(WORKFLOW)
    expect(await getStepCategory(S(s), 't1', 'incident', 'fixed')).toBe('resolved')
    expect(await getStepCategory(S(s), 't1', 'incident', 'nope')).toBeNull()
    expect(await getStepPurpose(S(s), 't1', 'incident', 'working')).toBe('implementation')
    expect(await getStepPurpose(S(s), 't1', 'incident', 'new')).toBeNull()
    expect(await getStepPurpose(S(s), 't1', 'incident', 'nope')).toBeNull()
    expect((await getStepRow(S(s), 't1', 'incident', 'done'))!.isTerminal).toBe(true)
    expect(await getStepRow(S(s), 't1', 'incident', 'nope')).toBeNull()
  })
})

describe('status classes', () => {
  it('groups the steps into the four portal classes', async () => {
    const byClass = await getStepNamesByClass(S(fakeSession(WORKFLOW)), 't1', 'incident')
    expect(Object.keys(byClass).sort()).toEqual([...TICKET_STATUS_CLASSES].sort())
    expect(byClass).toEqual({
      open: ['new', 'working'],
      in_progress: ['working'],
      resolved: ['fixed'],
      closed: ['done', 'cancelled'],
    })
  })

  it('two active definitions with the same step name contribute it once', async () => {
    const byClass = await getStepNamesByClass(S(fakeSession([step('new', { isInitial: true }), step('new')])), 't1', 'incident')
    // The second definition makes "new" in progress; it still appears once in "open".
    expect(byClass.open).toEqual(['new'])
    expect(byClass.in_progress).toEqual(['new'])
  })
})

describe('steps by purpose', () => {
  it('returns every step with one of the purposes, de-duplicated', async () => {
    const s = fakeSession([...WORKFLOW, step('done', { purpose: 'closure' })])
    expect(await getStepNamesByPurpose(S(s), 't1', 'incident', ['closure', 'implementation'])).toEqual(['working', 'done', 'cancelled'])
    expect(await getStepNamesByPurpose(S(s), 't1', 'incident', ['approval'])).toEqual([])
  })

  it('the fail-loud variant returns the names when there are some', async () => {
    expect(await requireStepNamesByPurpose(S(fakeSession(WORKFLOW)), 't1', 'incident', ['closure'], 'Auto-close')).toEqual(['done', 'cancelled'])
  })

  it('the fail-loud variant stops, naming the operation, when no step has the purpose', async () => {
    await expect(requireStepNamesByPurpose(S(fakeSession(WORKFLOW)), 't1', 'change', ['approval', 'scheduled'], 'Approval gate'))
      .rejects.toThrow('Approval gate: in the "change" workflow of tenant t1 no step declares the purpose [approval, scheduled]')
  })
})

describe('the current step of an entity', () => {
  it('returns the instance step, or null when there is no workflow instance', async () => {
    const s = fakeSession([{ step: 'working' }])
    expect(await getEntityCurrentStep(S(s), 'inc-1', 't1')).toBe('working')
    expect(s.run.mock.calls[0]![1]).toEqual({ entityId: 'inc-1', tenantId: 't1' })
    expect(await getEntityCurrentStep(S(fakeSession([])), 'inc-1', 't1')).toBeNull()
  })

  it('terminal / open follow the step flag; no instance means open', async () => {
    expect(await isEntityInTerminalStep(S(fakeSession([{ terminal: true }])), 'e', 't1')).toBe(true)
    expect(await isEntityOpen(S(fakeSession([{ terminal: true }])), 'e', 't1')).toBe(false)
    expect(await isEntityInTerminalStep(S(fakeSession([{ terminal: null }])), 'e', 't1')).toBe(false)
    expect(await isEntityInTerminalStep(S(fakeSession([])), 'e', 't1')).toBe(false)
    expect(await isEntityOpen(S(fakeSession([])), 'e', 't1')).toBe(true)
  })

  it('closed and concluded are true only on an explicit true (null is not closed)', async () => {
    expect(await isEntityClosed(S(fakeSession([{ closed: true }])), 'e', 't1')).toBe(true)
    expect(await isEntityClosed(S(fakeSession([{ closed: null }])), 'e', 't1')).toBe(false)
    expect(await isEntityClosed(S(fakeSession([])), 'e', 't1')).toBe(false)
    expect(await isEntityConcluded(S(fakeSession([{ concluded: true }])), 'e', 't1')).toBe(true)
    expect(await isEntityConcluded(S(fakeSession([{ concluded: false }])), 'e', 't1')).toBe(false)
    expect(await isEntityConcluded(S(fakeSession([])), 'e', 't1')).toBe(false)
  })

  it('"concluded" includes a resolved step that the customer made non-terminal', async () => {
    // The Cypher is what encodes this rule: pin it, since escalations rely on it.
    const s = fakeSession([{ concluded: true }])
    await isEntityConcluded(S(s), 'e', 't1')
    expect(s.run.mock.calls[0]![0]).toMatch(/s\.category IN \['resolved', 'closed'\] OR coalesce\(s\.is_terminal, false\)/)
  })
})
