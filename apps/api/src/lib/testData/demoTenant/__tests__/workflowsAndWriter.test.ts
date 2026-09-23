/**
 * THE TWO PIECES THAT TOUCH THE DATABASE, WITHOUT A DATABASE.
 *
 * `loadTicketWorkflows` reads the tenant's own definitions — the ones every
 * simulated move is checked against — and `DemoWriter` writes. Both are the
 * places where a demo tenant stops being a plan and becomes rows, so both are
 * exercised here against a session that only records what it was asked.
 *
 * What is pinned, and why:
 *  - the choice of definition for a new ticket must be the ENGINE's choice
 *    (the category's own first, then the one without, highest version): a
 *    generator that picked differently would write a history the app could
 *    never have produced;
 *  - `assertMove` must refuse a move that is not in the definition, and its
 *    message must say which ones were allowed — that message is the whole
 *    value of the check when a customer's designer changes a workflow;
 *  - the writer must add the tenant and the run mark to EVERY node (without
 *    the mark `--clean` cannot find it again), and must shout when an edge
 *    finds no end instead of writing half a graph.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  assertMove, conditionHolds, loadTicketWorkflows, WorkflowRuleError, type LiveDefinition,
} from '../workflowModel.js'
import { DemoWriter, DEMO_RUN_PROPERTY, int, toNeo4jValue } from '../writer.js'
import { DEFINITIONS } from './fixtures.js'

/** A session that answers with the given rows and remembers every statement. */
function fakeSession(answers: Array<Array<Record<string, unknown>>>) {
  const statements: Array<{ cypher: string; params: Record<string, unknown> }> = []
  let call = 0
  const run = vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    statements.push({ cypher, params })
    const rows = answers[call++] ?? []
    return { records: rows.map((r) => ({ keys: Object.keys(r), get: (k: string) => r[k] })) }
  })
  const session = {
    run,
    executeWrite: (work: (tx: unknown) => unknown) => work({ run }),
    executeRead: (work: (tx: unknown) => unknown) => work({ run }),
  }
  return { session: session as never, statements }
}

const step = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `s-${name}`, name, label: null, type: 'standard', is_initial: false, is_terminal: false, step_order: 2, ...extra,
})

describe('loadTicketWorkflows', () => {
  const rows = [{
    d: { id: 'wd-1', name: 'Incident Management', entity_type: 'incident', category: null, version: 2 },
    steps: [
      step('new', { type: 'start', step_order: 1 }),
      step('pending', { enter_actions: JSON.stringify([{ type: 'sla_pause', params: { sla_type: 'resolve' } }]) }),
      step('closed', { type: 'end', is_open: false }),
    ],
    transitions: [
      { from: 'new', to: 'pending', trigger: 'manual', condition: null },
      null,
      { from: 'pending', to: 'closed', trigger: 'timer', condition: null },
    ],
  }]

  it('reads the steps, their SLA pause and the transitions, dropping the empty rows', async () => {
    const { session } = fakeSession([rows])
    const wf = await loadTicketWorkflows(session, 'c-test')
    const def = wf.byId('wd-1')
    expect(def.initialStep.name).toBe('new')
    expect(def.steps.get('pending')!.slaPause).toBe('resolve')
    expect(def.steps.get('new')!.slaPause).toBeNull()
    expect(def.steps.get('new')!.label).toBe('new')       // no label: the name stands in
    expect(def.steps.get('closed')!.isTerminal).toBe(true)
    expect(def.steps.get('closed')!.isOpen).toBe(false)
    expect(def.transitions).toHaveLength(2)
  })

  it('takes the category\'s own definition, and the highest version among ties', async () => {
    const security = {
      d: { id: 'wd-sec', name: 'Security', entity_type: 'incident', category: 'security', version: 1 },
      steps: [step('new', { type: 'start' })], transitions: [],
    }
    const newer = {
      d: { id: 'wd-3', name: 'Incident v3', entity_type: 'incident', category: null, version: 3 },
      steps: [step('new', { type: 'start' })], transitions: [],
    }
    const { session } = fakeSession([[...rows, security, newer]])
    const wf = await loadTicketWorkflows(session, 'c-test')
    expect(wf.forTicket('incident', 'security').id).toBe('wd-sec')
    expect(wf.forTicket('incident', null).id).toBe('wd-3')
    // A category with no definition of its own falls back to the one without.
    expect(wf.forTicket('incident', 'network').id).toBe('wd-3')
    expect(wf.all).toHaveLength(3)
  })

  it('an sla_pause with no type pauses both clocks', async () => {
    const both = [{
      ...rows[0]!,
      steps: [step('new', { type: 'start' }), step('waiting', { enter_actions: JSON.stringify([{ type: 'notify' }, { type: 'sla_pause' }]) })],
    }]
    const { session } = fakeSession([both])
    const wf = await loadTicketWorkflows(session, 'c-test')
    expect(wf.all[0]!.steps.get('waiting')!.slaPause).toBe('both')
  })

  it('a step marked initial without the start type is still the initial one', async () => {
    const marked = [{ ...rows[0]!, steps: [step('draft', { type: 'standard', is_initial: true })] }]
    const { session } = fakeSession([marked])
    const wf = await loadTicketWorkflows(session, 'c-test')
    expect(wf.all[0]!.initialStep.name).toBe('draft')
  })

  it('stops on a definition with no initial step, on a missing id and on a missing entity type', async () => {
    const headless = [{ ...rows[0]!, steps: [step('middle')] }]
    await expect(loadTicketWorkflows(fakeSession([headless]).session, 'c-test')).rejects.toThrow(/has no initial step/)

    const wf = await loadTicketWorkflows(fakeSession([rows]).session, 'c-test')
    expect(() => wf.byId('nope')).toThrow(WorkflowRuleError)
    expect(() => wf.forTicket('problem', null)).toThrow(/no active "problem" workflow/)
  })
})

describe('conditionHolds', () => {
  it('knows the conditions the shipped definitions use', () => {
    expect(conditionHolds(null, {})).toBe(true)
    expect(conditionHolds('rootCause != null', { rootCause: 'disk full' })).toBe(true)
    expect(conditionHolds('rootCause != null', { rootCause: '  ' })).toBe(false)
    expect(conditionHolds('rootCause != null', {})).toBe(false)
    expect(conditionHolds('has_linked_change', { hasLinkedChange: true })).toBe(true)
    expect(conditionHolds('has_linked_change', {})).toBe(false)
    expect(conditionHolds('all_assessments_complete', { allAssessmentsComplete: true })).toBe(true)
    expect(conditionHolds('all_deployments_complete', { allDeploymentsComplete: true })).toBe(true)
    expect(conditionHolds('all_reviews_confirmed', { allReviewsConfirmed: true })).toBe(true)
  })

  it('stops on a condition it does not know how to satisfy', () => {
    // A customer who writes their own condition in the designer must get a
    // loud stop, not a history that ignores it.
    expect(() => conditionHolds('budget_approved', {})).toThrow(WorkflowRuleError)
  })
})

describe('assertMove', () => {
  const incident = DEFINITIONS.find((d) => d.id === 'wd-inc')!

  it('returns the step it moved to', () => {
    expect(assertMove(incident, 'new', 'assigned', 'manual', {}, 'test').name).toBe('assigned')
  })

  it('refuses a move the definition does not have, and says what was allowed', () => {
    expect(() => assertMove(incident, 'new', 'resolved', 'manual', {}, 'INC001'))
      .toThrow(/INC001.*no manual transition new → resolved \(allowed: assigned \(manual\)\)/)
    expect(() => assertMove(incident, 'closed', 'new', 'manual', {}, 'INC001')).toThrow(/allowed: none/)
  })

  it('refuses a move whose condition does not hold', () => {
    expect(() => assertMove(incident, 'in_progress', 'resolved', 'manual', {}, 'INC001'))
      .toThrow(/condition "rootCause != null" of in_progress → resolved does not hold/)
    expect(assertMove(incident, 'in_progress', 'resolved', 'manual', { rootCause: 'fixed' }, 'INC001').name).toBe('resolved')
  })

  it('the trigger must match, except the automatic-on-manual the app itself does', () => {
    expect(() => assertMove(incident, 'new', 'assigned', 'automatic', {}, 'INC001')).toThrow(WorkflowRuleError)
    expect(assertMove(incident, 'new', 'assigned', 'automatic', {}, 'INC001', { automaticOnManual: true }).name).toBe('assigned')
  })

  it('stops when the arrival step is missing from the definition', () => {
    const broken: LiveDefinition = { ...incident, steps: new Map(incident.steps), transitions: incident.transitions }
    broken.steps.delete('assigned')
    expect(() => assertMove(broken, 'new', 'assigned', 'manual', {}, 'INC001')).toThrow(/step "assigned" is missing/)
  })
})

describe('DemoWriter', () => {
  it('the run mark is the word the queries read', () => {
    // `clean.ts` and `generate.ts` write `n.demo_run_id` as a literal so the
    // cypher guardian can verify those queries: the two must say the same word.
    expect(DEMO_RUN_PROPERTY).toBe('demo_run_id')
  })

  it('adds the tenant and the run mark to every node, in batches', async () => {
    const { session, statements } = fakeSession([])
    const progress: Array<[string, number, number]> = []
    const writer = new DemoWriter(session, 'c-test', 'run-1', 2, (what, done, total) => progress.push([what, done, total]))
    await writer.nodes(['ConfigurationItem', 'Server'], [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(statements).toHaveLength(2)
    expect(statements[0]!.cypher).toContain('CREATE (n:ConfigurationItem:Server)')
    const rows = statements[0]!.params['rows'] as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({ id: 'a', tenant_id: 'c-test', demo_run_id: 'run-1' })
    expect(writer.stats.nodes).toBe(3)
    expect(progress).toEqual([['ConfigurationItem:Server', 2, 3], ['ConfigurationItem:Server', 3, 3]])
  })

  it('refuses a label or a relationship type that is not a plain identifier', async () => {
    const { session } = fakeSession([])
    const writer = new DemoWriter(session, 'c-test', 'run-1')
    await expect(writer.nodes(['Server {})-[:OWNS]->(x'], [{ id: 'a' }])).rejects.toThrow(/not a plain identifier/)
    await expect(writer.relationships('Server', 'owns', 'Team', [])).rejects.toThrow(/not a plain identifier/)
  })

  it('shouts when an edge finds no end', async () => {
    const { session, statements } = fakeSession([[{ n: 2 }], [{ n: 1 }]])
    const writer = new DemoWriter(session, 'c-test', 'run-1')
    await writer.relationships('Application', 'DEPENDS_ON', 'Server', [{ from: 'a', to: 's' }, { from: 'b', to: 's', props: { since: 2024 } }])
    expect(writer.stats.relationships).toBe(2)
    expect(statements[0]!.cypher).toContain('CREATE (a)-[r:DEPENDS_ON]->(b)')
    expect((statements[0]!.params['rows'] as Array<Record<string, unknown>>)[0]!['props']).toEqual({})

    await expect(writer.relationships('Application', 'DEPENDS_ON', 'Server', [{ from: 'x', to: 'y' }, { from: 'z', to: 'y' }]))
      .rejects.toThrow('writer: 1 of 2 Application-DEPENDS_ON->Server edges found no end')
  })

  it('writes children under their parent, and shouts when a parent is missing', async () => {
    const { session, statements } = fakeSession([[{ n: 1 }], [{ n: 0 }]])
    const writer = new DemoWriter(session, 'c-test', 'run-1')
    await writer.children('WorkflowInstance', 'STEP_HISTORY', ['WorkflowStepExecution'], [
      { parent: 'wi-1', props: { id: 'x-1', step_name: 'new' }, relProps: { order: int(1) } },
    ])
    expect(statements[0]!.cypher).toContain('CREATE (p)-[r:STEP_HISTORY]->(n:WorkflowStepExecution)')
    const row = (statements[0]!.params['rows'] as Array<Record<string, unknown>>)[0]!
    expect(row['props']).toMatchObject({ id: 'x-1', tenant_id: 'c-test', demo_run_id: 'run-1' })
    expect(writer.stats.nodes).toBe(1)
    expect(writer.stats.relationships).toBe(1)

    await expect(writer.children('WorkflowInstance', 'STEP_HISTORY', ['WorkflowStepExecution'], [
      { parent: 'gone', props: { id: 'x-2' } },
    ])).rejects.toThrow(/found no parent/)
  })

  it('links a question to every CI type, and counts what it expects', async () => {
    const { session, statements } = fakeSession([[{ n: 4 }], [{ n: 3 }]])
    const writer = new DemoWriter(session, 'c-test', 'run-1')
    const links = [{ questionId: 'q1', weight: 2, sortOrder: 0 }, { questionId: 'q2', weight: 1, sortOrder: 1 }]
    await writer.questionLinks(links, ['ct-1', 'ct-2'])
    expect(writer.stats.relationships).toBe(4)
    expect(statements[0]!.params['ciTypeIds']).toEqual(['ct-1', 'ct-2'])

    await expect(writer.questionLinks(links, ['ct-1', 'ct-2'])).rejects.toThrow('writer: 3 question links written, 4 expected')
  })

  it('does not write a node when there is nothing to write', async () => {
    const { session, statements } = fakeSession([])
    const writer = new DemoWriter(session, 'c-test', 'run-1')
    await writer.nodes(['Server'], [])
    await writer.relationships('Server', 'OWNED_BY', 'Team', [])
    expect(statements).toHaveLength(0)
  })
})

describe('the values the writer sends', () => {
  it('drops undefined and keeps null, down the whole tree', () => {
    const out = toNeo4jValue({ a: 1, b: undefined, c: null, d: { e: undefined, f: [1, 2] } }) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['a', 'c', 'd'])
    expect(Object.keys(out['d'] as Record<string, unknown>)).toEqual(['f'])
    expect(out['c']).toBeNull()
    expect((out['d'] as Record<string, unknown>)['f']).toEqual([1, 2])
  })

  it('a date and an integer pass through untouched', () => {
    const d = new Date('2026-09-22T10:00:00.000Z')
    expect(toNeo4jValue(d)).toBe(d)
    const i = int(3)
    expect(toNeo4jValue(i)).toBe(i)
  })

  it('an integer must be whole: a float where the app writes toInteger() is a defect', () => {
    expect(() => int(1.5)).toThrow(/not a whole number/)
  })
})
