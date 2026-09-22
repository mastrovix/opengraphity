/**
 * Step rules of customer fields: the parts not pinned by customFieldSteps.test.ts
 * — corrupt stored JSON, the "from" shape, and the three readers of the workflow.
 *
 * Why these behaviours matter: one malformed `step_visibility` used to be a bare
 * SyntaxError (a 500 with no field name) that blocked the whole metamodel; the
 * creation context decides which fields appear in the "new ticket" form, so a
 * wrong initial step shows "Outcome" to whoever opens a change; and a ticket
 * without a workflow instance must keep its fields visible rather than hide them.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Session } from 'neo4j-driver'
import {
  parseStepVisibility, parseStepEditability, stepsNamedBy, assertStepsExist,
  ticketStepContext, creationStepContext, workflowStepsByDefinition, workflowStepNames,
} from '../customFieldSteps.js'

const i18nKey = (fn: () => unknown): string | null => {
  try { fn(); return null } catch (e) { return (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key ?? (e as Error).message }
}

/** A session whose read returns the given records (each a plain object read with `get`). */
function sessionReturning(rows: Array<Record<string, unknown>>) {
  const run = vi.fn(async (..._a: unknown[]) => ({ records: rows.map((r) => ({ get: (k: string) => r[k] })) }))
  const session = { executeRead: vi.fn(async (fn: (tx: { run: typeof run }) => unknown) => fn({ run })) }
  return { session: session as unknown as Session, run }
}

describe('parsing saved rules', () => {
  it('corrupt JSON is a keyed error naming the field, for both rules', () => {
    expect(i18nKey(() => parseStepVisibility('{oops', 'Outcome'))).toBe('errors.customField.stepRulesJson')
    expect(i18nKey(() => parseStepEditability('{oops', 'Outcome'))).toBe('errors.customField.stepRulesJson')
    expect(() => parseStepVisibility('{oops', 'Outcome')).toThrow(/^Outcome: the saved step rules are not valid JSON/)
  })

  it('empty string and explicit defaults read as "always" / "where visible"', () => {
    expect(parseStepVisibility('', 'x')).toEqual({ mode: 'always' })
    expect(parseStepVisibility('{"mode":"always"}', 'x')).toEqual({ mode: 'always' })
    expect(parseStepEditability('', 'x')).toEqual({ mode: 'visible' })
    expect(parseStepEditability('{"mode":"visible"}', 'x')).toEqual({ mode: 'visible' })
  })

  it('"from" needs a non-blank step, and the step is trimmed', () => {
    expect(parseStepVisibility({ mode: 'from', step: '  review ' }, 'x')).toEqual({ mode: 'from', step: 'review' })
    expect(i18nKey(() => parseStepVisibility({ mode: 'from', step: '  ' }, 'x'))).toBe('errors.customField.stepRulesShape')
    expect(i18nKey(() => parseStepVisibility({ mode: 'from' }, 'x'))).toBe('errors.customField.stepRulesShape')
  })

  it('step lists are trimmed and de-duplicated; blank names are rejected', () => {
    expect(parseStepEditability({ mode: 'steps', steps: ['a', ' a ', 'b'] }, 'x')).toEqual({ mode: 'steps', steps: ['a', 'b'] })
    expect(i18nKey(() => parseStepVisibility({ mode: 'steps', steps: ['a', ' '] }, 'x'))).toBe('errors.customField.stepRulesShape')
    expect(i18nKey(() => parseStepEditability({ mode: 'always' }, 'x'))).toBe('errors.customField.stepRulesShape')
  })
})

describe('steps named by the rules', () => {
  it('collects every step once, from both rules', () => {
    expect(stepsNamedBy({ mode: 'steps', steps: ['a', 'b'] }, { mode: 'steps', steps: ['b', 'c'] })).toEqual(['a', 'b', 'c'])
    expect(stepsNamedBy({ mode: 'from', step: 'r' }, { mode: 'visible' })).toEqual(['r'])
    expect(stepsNamedBy({ mode: 'always' }, { mode: 'visible' })).toEqual([])
  })

  it('known steps pass', () => {
    expect(() => assertStepsExist({ mode: 'steps', steps: ['a'] }, { mode: 'visible' }, ['a', 'b'], 'F')).not.toThrow()
  })
})

describe('ticketStepContext', () => {
  it('a ticket without a workflow instance has no context (fields stay visible)', async () => {
    expect(await ticketStepContext(sessionReturning([]).session, 't1', 'INC1')).toBeNull()
    expect(await ticketStepContext(sessionReturning([{ current: null, visited: [] }]).session, 't1', 'INC1')).toBeNull()
  })

  it('adds the current step to the visited ones when history does not have it yet', async () => {
    const { session, run } = sessionReturning([{ current: 'assigned', visited: ['new', null] }])
    expect(await ticketStepContext(session, 't1', 'INC1')).toEqual({ current: 'assigned', visited: ['new', 'assigned'] })
    // Tenant scoping: the ticket is looked up inside its tenant only.
    expect(run.mock.calls[0]).toEqual([expect.any(String), { ticketId: 'INC1', tenantId: 't1' }])
  })

  it('does not duplicate the current step when history already has it; null history is empty', async () => {
    expect(await ticketStepContext(sessionReturning([{ current: 'new', visited: ['new'] }]).session, 't', 'x'))
      .toEqual({ current: 'new', visited: ['new'] })
    expect(await ticketStepContext(sessionReturning([{ current: 'new', visited: null }]).session, 't', 'x'))
      .toEqual({ current: 'new', visited: ['new'] })
  })
})

describe('creationStepContext', () => {
  it('the opening of a ticket is its initial step', async () => {
    const { session, run } = sessionReturning([{ initial: 'new' }])
    expect(await creationStepContext(session, 't1', 'incident', 'network')).toEqual({ current: 'new', visited: ['new'] })
    expect(run.mock.calls[0]?.[1]).toEqual({ tenantId: 't1', entityType: 'incident', category: 'network' })
  })

  it('no active definition means no context', async () => {
    expect(await creationStepContext(sessionReturning([]).session, 't1', 'incident', null)).toBeNull()
  })
})

describe('workflow steps for the designer', () => {
  it('maps each definition with numeric order and only string labels', async () => {
    const { session } = sessionReturning([
      { workflow: 'Default', category: null, steps: [{ name: 'new', label: 'New', labels: '{"it":"Nuovo"}', order: 1 }, { name: 'x', label: 'x', labels: { bad: true }, order: '999' }] },
      { workflow: 'Net', category: 'network', steps: [] },
    ])
    expect(await workflowStepsByDefinition(session, 't1', 'incident')).toEqual([
      { workflow: 'Default', category: null, steps: [
        { name: 'new', label: 'New', labels: '{"it":"Nuovo"}', order: 1 },
        { name: 'x', label: 'x', labels: null, order: 999 },
      ] },
      { workflow: 'Net', category: 'network', steps: [] },
    ])
  })

  it('a definition row with an undefined category reads as null', async () => {
    const { session } = sessionReturning([{ workflow: 'W', steps: [] }])
    expect((await workflowStepsByDefinition(session, 't1', 'change'))[0]?.category).toBeNull()
  })

  it('step names come back sorted, and empty when there is no workflow', async () => {
    expect(await workflowStepNames(sessionReturning([{ names: ['review', 'assessment'] }]).session, 't', 'change')).toEqual(['assessment', 'review'])
    expect(await workflowStepNames(sessionReturning([]).session, 't', 'change')).toEqual([])
    expect(await workflowStepNames(sessionReturning([{ names: null }]).session, 't', 'change')).toEqual([])
  })
})
