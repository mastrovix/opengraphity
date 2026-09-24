/**
 * What each ITSM transition guard actually decides, and that the module wires
 * itself into the engine on import.
 *
 * Why it matters: these guards are the only thing standing between a change
 * and its next step. A guard that opens when the entity is missing, when a
 * change has no affected CI, or when the lookup is not tenant-scoped lets a
 * ticket skip assessments, deployments or reviews; a guard that never opens
 * turns a workflow arc into a wall. And if the module stopped registering the
 * guards or the task creator on import, every process that runs transitions
 * would reject known conditions or silently advance tickets without tasks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import neo4j from 'neo4j-driver'

const registerCondition = vi.fn()
const registerTaskCreator = vi.fn()
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { registerCondition: (...a: unknown[]) => registerCondition(...a) as unknown },
  registerTaskCreator: (...a: unknown[]) => registerTaskCreator(...a) as unknown,
  registerStepActionHandlers: vi.fn(),
}))
const runQueryOne = vi.fn()
vi.mock('../../lib/db.js', () => ({
  runQueryOne: (...a: unknown[]) => runQueryOne(...a) as unknown,
}))
const areAllAssessmentsComplete = vi.fn()
vi.mock('../../lib/changeAssessments.js', () => ({
  areAllAssessmentsComplete: (...a: unknown[]) => areAllAssessmentsComplete(...a) as unknown,
}))
vi.mock('../stepEnteredEvents.js', () => ({}))
const compitiDaFareNelPasso = vi.fn()
const creaCompito = vi.fn()
vi.mock('../../lib/ticketTasks.js', () => ({
  compitiDaFareNelPasso: (...a: unknown[]) => compitiDaFareNelPasso(...a) as unknown,
  creaCompito: (...a: unknown[]) => creaCompito(...a) as unknown,
}))

// Captured before any beforeEach clears the mocks: registration happens once, at import.
const { CHANGE_CONDITIONS, registerWorkflowConditions } = await import('../conditions.js')
const registeredAtImport = registerCondition.mock.calls.map((c) => c[0] as string)
const taskCreator = registerTaskCreator.mock.calls[0]?.[0] as ((t: unknown) => Promise<string>) | undefined

const session = { tag: 'session' } as never
const ctx = { entityId: 'chg-1', tenantId: 't1', fromStepName: 'implementation' } as never
const evaluate = (name: string) => CHANGE_CONDITIONS[name]!.evaluate(session, ctx)
const lastParams = () => runQueryOne.mock.calls.at(-1)![2] as Record<string, unknown>

beforeEach(() => {
  runQueryOne.mockReset()
  areAllAssessmentsComplete.mockReset()
  compitiDaFareNelPasso.mockReset()
  creaCompito.mockReset()
  registerCondition.mockClear()
})

describe('registration on import', () => {
  it('registers every ITSM condition and the task creator', () => {
    expect(registeredAtImport.sort()).toEqual(Object.keys(CHANGE_CONDITIONS).sort())
    expect(taskCreator).toBeTypeOf('function')
  })

  it('registerWorkflowConditions passes each evaluator with its refusal message', () => {
    registerWorkflowConditions()
    for (const [name, { evaluate: ev, failureMessage }] of Object.entries(CHANGE_CONDITIONS)) {
      expect(registerCondition).toHaveBeenCalledWith(name, ev, failureMessage)
    }
  })

  it('the registered task creator delegates to creaCompito and returns the new task id', async () => {
    creaCompito.mockResolvedValueOnce('task-42')
    const task = { tenantId: 't1', title: 'Check backups' }
    await expect(taskCreator!(task)).resolves.toBe('task-42')
    expect(creaCompito).toHaveBeenCalledWith(task)
  })
})

describe('has_linked_change', () => {
  it('opens only when at least one resolving change exists, scoped to the tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ n: 2 })
    await expect(evaluate('has_linked_change')).resolves.toBe(true)
    expect(lastParams()).toEqual({ entityId: 'chg-1', tenantId: 't1' })
    runQueryOne.mockResolvedValueOnce({ n: 0 })
    await expect(evaluate('has_linked_change')).resolves.toBe(false)
  })

  it('stays closed when no row comes back', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(evaluate('has_linked_change')).resolves.toBe(false)
  })
})

describe('all_assessments_complete', () => {
  it('delegates to the shared assessment + release plan check', async () => {
    areAllAssessmentsComplete.mockResolvedValueOnce(true)
    await expect(evaluate('all_assessments_complete')).resolves.toBe(true)
    expect(areAllAssessmentsComplete).toHaveBeenCalledWith(session, 'chg-1', 't1')
    areAllAssessmentsComplete.mockResolvedValueOnce(false)
    await expect(evaluate('all_assessments_complete')).resolves.toBe(false)
  })
})

describe.each(['all_deployments_complete', 'all_reviews_confirmed'])('%s', (name) => {
  it('opens only when nothing is pending', async () => {
    runQueryOne.mockResolvedValueOnce({ pending: 0 })
    await expect(evaluate(name)).resolves.toBe(true)
    expect(lastParams()).toMatchObject({ changeId: 'chg-1', tenantId: 't1' })
    runQueryOne.mockResolvedValueOnce({ pending: 3 })
    await expect(evaluate(name)).resolves.toBe(false)
  })

  it('stays closed when the change was not found (no row, or a null count)', async () => {
    // A missing row must not read as "0 pending": that would let a deleted or
    // foreign-tenant change pass the guard.
    runQueryOne.mockResolvedValueOnce(null)
    await expect(evaluate(name)).resolves.toBe(false)
    runQueryOne.mockResolvedValueOnce({ pending: null })
    await expect(evaluate(name)).resolves.toBe(false)
  })

  it('accepts Neo4j integers for the count', async () => {
    runQueryOne.mockResolvedValueOnce({ pending: neo4j.int(0) })
    await expect(evaluate(name)).resolves.toBe(true)
  })

  it('treats a change with no affected CI as pending (the query returns 1)', async () => {
    // Pinned in the Cypher: an empty change must not satisfy "all done".
    runQueryOne.mockResolvedValueOnce({ pending: 1 })
    await expect(evaluate(name)).resolves.toBe(false)
    expect(runQueryOne.mock.calls.at(-1)![1]).toContain('CASE WHEN ciCount = 0 THEN 1 ELSE pending END')
  })
})

describe('all_tasks_complete', () => {
  it('opens only when no task of the step being left is still to do', async () => {
    compitiDaFareNelPasso.mockResolvedValueOnce(0)
    await expect(evaluate('all_tasks_complete')).resolves.toBe(true)
    expect(compitiDaFareNelPasso).toHaveBeenCalledWith(session, 't1', 'chg-1', 'implementation')
    compitiDaFareNelPasso.mockResolvedValueOnce(2)
    await expect(evaluate('all_tasks_complete')).resolves.toBe(false)
  })
})
