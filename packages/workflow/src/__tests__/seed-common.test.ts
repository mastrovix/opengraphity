/**
 * Personalizzazioni, ondata 2 (A2-1 / B-2): rieseguire un seed non deve
 * cancellare la configurazione del cliente.
 *
 * Il caso vero: «Incident Management» di c-one è v3, con un `create_entity`
 * condizionato su `escalated` e una transizione in più. Prima di questa ondata
 * un `seed:incident-workflow` la riportava a v1 di fabbrica — SET incondizionati
 * sui passi, `DELETE t` su tutte le transizioni — senza un solo avviso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  seedWorkflowDefinition, CustomizedWorkflowError, computeSeedDiff, formatSeedDiff, seedDiffIsEmpty,
  type SeedableWorkflow,
} from '../seed-common.js'
import { int as neo4jInt } from 'neo4j-driver'

/**
 * `getSession` is faked only for the tests at the bottom (the seed run
 * WITHOUT a session). Everything else in this file passes its own session and
 * never sees it; `toNumber` stays the real one because the diff genuinely
 * leans on it.
 */
const fakeGetSession = vi.fn()
vi.mock('@opengraphity/neo4j', async (importOriginal) => ({
  ...await importOriginal<typeof import('@opengraphity/neo4j')>(),
  getSession: (...a: unknown[]) => fakeGetSession(...a) as unknown,
}))

const FACTORY: SeedableWorkflow = {
  name:       'Incident Management',
  entityType: 'incident',
  version:    1,
  active:     true,
  steps: [
    { id: 'step-new',       name: 'new',       label: 'Nuovo',  type: 'start',    enterActions: [], exitActions: [], metadata: { step_order: 1, category: 'active' } },
    { id: 'step-escalated', name: 'escalated', label: 'Escalato', type: 'standard', enterActions: [], exitActions: [], metadata: { step_order: 6, category: 'escalated' } },
  ],
  transitions: [
    { id: 'tr-new-esc', fromStepName: 'new', toStepName: 'escalated', trigger: 'manual', label: 'Escalate', condition: null, requiresInput: false, inputField: null },
  ],
}

/** Com'è il grafo del cliente: v3, un'azione in più su `escalated`, un passo suo. */
const LIVE_STEPS = [
  { name: 'new',       label: 'Nuovo',    type: 'start',    enterActions: '[]', exitActions: '[]', props: { step_order: 1, category: 'active' } },
  { name: 'escalated', label: 'Escalato', type: 'standard', enterActions: '[{"type":"create_entity","params":{"when":"escalated"}}]', exitActions: '[]', props: { step_order: 6, category: 'escalated' } },
  { name: 'triage_cliente', label: 'Triage', type: 'standard', enterActions: '[]', exitActions: '[]', props: { step_order: 9, category: 'active' } },
]
const LIVE_TRS = [
  { fromStepName: 'new', toStepName: 'escalated', trigger: 'manual', label: 'Escalate', condition: null, requiresInput: false, inputField: null },
  { fromStepName: 'new', toStepName: 'triage_cliente', trigger: 'manual', label: 'Triage', condition: null, requiresInput: false, inputField: null },
]

function rows(list: Record<string, unknown>[]) {
  return { records: list.map((r) => ({ get: (k: string) => r[k] })) }
}

interface FakeOpts {
  /** null = la definizione non esiste ancora. */
  existing?: Record<string, unknown> | null
}

function fakeSession(opts: FakeOpts = {}) {
  const existing = opts.existing === undefined
    ? { id: 'def-1', version: 3, active: true, category: null, customizedAt: null, customizedBy: null }
    : opts.existing
  const queries: string[] = []
  const txRun = vi.fn(async (cypher: string, _params: Record<string, unknown> = {}) => {
    queries.push(cypher)
    if (cypher.includes('RETURN wd.id AS id, wd.version AS version')) return existing === null ? rows([]) : rows([existing])
    if (cypher.includes('RETURN s.name AS name, s.label AS label'))   return rows(LIVE_STEPS)
    if (cypher.includes('RETURN from.name AS fromStepName'))          return rows(LIVE_TRS)
    if (cypher.includes('MERGE (wd:WorkflowDefinition'))              return rows([{ id: existing === null ? 'def-new' : 'def-1' }])
    if (cypher.includes('RETURN s.name AS name, count(wi) AS live'))  return rows([])
    if (cypher.includes('CREATE (from)-[:TRANSITIONS_TO'))            return rows([{ n: FACTORY.transitions.length }])
    if (cypher.includes('RETURN count(wi) AS n'))                     return rows([{ n: 0 }])
    return rows([])
  })
  return {
    queries,
    txRun,
    executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })),
  }
}

const wrote = (q: string[]) => ({
  steps:       q.some((c) => c.includes('MERGE (s:WorkflowStep')),
  definition:  q.some((c) => c.includes('MERGE (wd:WorkflowDefinition')),
  transitions: q.some((c) => c.includes('DELETE t')),
})

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('seedWorkflowDefinition — B-2: il seed non distrugge le personalizzazioni', () => {
  it('crea la definizione quando non esiste (il caso c-two)', async () => {
    const s = fakeSession({ existing: null })
    const r = await seedWorkflowDefinition('c-two', FACTORY, { session: s as never })
    expect(r.created).toBe(true)
    expect(r.skipped).toBe(false)
    expect(r.definitionId).toBe('def-new')
    expect(wrote(s.queries)).toEqual({ steps: true, definition: true, transitions: true })
  })

  it('una definizione che esiste già viene SALTATA: nessuna scrittura su passi, transizioni o definizione', async () => {
    const s = fakeSession()
    const r = await seedWorkflowDefinition('c-one', FACTORY, { session: s as never })
    expect(r.created).toBe(false)
    expect(r.skipped).toBe(true)
    expect(r.skipReason).toBe('exists')
    expect(r.diff).toBeNull()
    expect(wrote(s.queries)).toEqual({ steps: false, definition: false, transitions: false })
  })

  it('il salto dice perché e come forzare', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession()
    await seedWorkflowDefinition('c-one', FACTORY, { session: s as never })
    const msg = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain('SALTATA')
    expect(msg).toContain('Incident Management')
    expect(msg).toContain('--overwrite')
  })

  it('con overwrite stampa il diff PRIMA di scrivere, poi scrive', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession()
    const r = await seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwrite: true })
    expect(r.skipped).toBe(false)
    expect(wrote(s.queries)).toEqual({ steps: true, definition: true, transitions: true })
    const printed = log.mock.calls.map((c) => String(c[0]))
    const diffAt  = printed.findIndex((l) => l.includes('Diff "Incident Management"'))
    expect(diffAt).toBeGreaterThanOrEqual(0)
    const joined = printed.join('\n')
    expect(joined).toContain('version 3 → 1')
    expect(joined).toContain('- passo "triage_cliente"')
    expect(joined).toContain('create_entity')
    expect(joined).toContain('- transizione new → triage_cliente [manual]')
    // il diff arriva prima della riga di conferma della scrittura
    expect(printed.findIndex((l) => l.includes('RISCRITTA dal seed'))).toBeGreaterThan(diffAt)
  })

  it('su una definizione marchiata come personalizzata l\'overwrite semplice si RIFIUTA, nominando data e autore', async () => {
    const s = fakeSession({ existing: { id: 'def-1', version: 3, active: true, category: null, customizedAt: '2026-09-11T10:22:00.000Z', customizedBy: 'user-42' } })
    await expect(seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwrite: true }))
      .rejects.toThrow(CustomizedWorkflowError)
    expect(wrote(s.queries)).toEqual({ steps: false, definition: false, transitions: false })

    const s2 = fakeSession({ existing: { id: 'def-1', version: 3, active: true, category: null, customizedAt: '2026-09-11T10:22:00.000Z', customizedBy: 'user-42' } })
    const err = await seedWorkflowDefinition('c-one', FACTORY, { session: s2 as never, overwrite: true }).catch((e: unknown) => e as Error)
    expect(err.message).toContain('Incident Management')
    expect(err.message).toContain('2026-09-11T10:22:00.000Z')
    expect(err.message).toContain('user-42')
    expect(err.message).toContain('--overwrite-customized')
  })

  it('overwriteCustomized scrive e toglie il marchio (implica overwrite)', async () => {
    const s = fakeSession({ existing: { id: 'def-1', version: 3, active: true, category: null, customizedAt: '2026-09-11T10:22:00.000Z', customizedBy: 'user-42' } })
    const r = await seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwriteCustomized: true })
    expect(r.skipped).toBe(false)
    expect(r.customizedAt).toBe('2026-09-11T10:22:00.000Z')
    const defWrite = s.queries.find((c) => c.includes('MERGE (wd:WorkflowDefinition'))!
    expect(defWrite).toContain('wd.customized_at = null')
    expect(defWrite).toContain('wd.seed_overwritten_at')
  })

  it('una definizione marchiata viene saltata anche senza overwrite, e il motivo nomina la personalizzazione', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession({ existing: { id: 'def-1', version: 3, active: true, category: null, customizedAt: '2026-09-11T10:22:00.000Z', customizedBy: 'user-42' } })
    const r = await seedWorkflowDefinition('c-one', FACTORY, { session: s as never })
    expect(r.skipped).toBe(true)
    expect(r.customizedBy).toBe('user-42')
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('personalizzata il 2026-09-11T10:22:00.000Z')
  })

  it('una definizione senza la proprietà customized_at non è considerata personalizzata (assente = non personalizzata)', async () => {
    const s = fakeSession({ existing: { id: 'def-1', version: 3, active: true, category: null } })
    const r = await seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwrite: true })
    expect(r.customizedAt).toBeNull()
    expect(r.skipped).toBe(false)
  })

  it('il seed di un tenant nuovo è idempotente: il secondo giro non scrive niente', async () => {
    const first = fakeSession({ existing: null })
    await seedWorkflowDefinition('c-two', FACTORY, { session: first as never })
    const second = fakeSession()
    await seedWorkflowDefinition('c-two', FACTORY, { session: second as never })
    expect(wrote(second.queries)).toEqual({ steps: false, definition: false, transitions: false })
  })
})

describe('computeSeedDiff', () => {
  const liveDef = { version: 3, active: true, category: null }

  it('elenca passi e transizioni aggiunti, rimossi e cambiati', () => {
    const d = computeSeedDiff(FACTORY, liveDef, LIVE_STEPS.map((s) => ({ ...s, metadata: s.props })), LIVE_TRS)
    expect(d.stepsRemoved).toEqual(['triage_cliente'])
    expect(d.stepsAdded).toEqual([])
    expect(d.stepsChanged.map((c) => c.name)).toEqual(['escalated'])
    expect(d.transitionsRemoved).toEqual(['new → triage_cliente [manual]'])
    expect(d.definitionFields.join()).toContain('version 3 → 1')
    expect(seedDiffIsEmpty(d)).toBe(false)
  })

  it('un grafo identico al seed produce un diff vuoto', () => {
    const steps = FACTORY.steps.map((s) => ({
      name: s.name, label: s.label, type: s.type,
      enterActions: JSON.stringify(s.enterActions), exitActions: JSON.stringify(s.exitActions),
      metadata: { ...s.metadata },
    }))
    const d = computeSeedDiff(FACTORY, { version: 1, active: true, category: null }, steps, FACTORY.transitions)
    expect(seedDiffIsEmpty(d)).toBe(true)
    expect(formatSeedDiff('x', 'c-two', d).join('\n')).toContain('nessuna differenza')
  })
})

/**
 * THE VALUES NEO4J RETURNS ARE NOT THE VALUES THE SEED WROTE.
 *
 * A `step_order: 1` written by the seed comes back from the graph as an
 * `Integer` (`{low, high}`), and a strict comparison would call it "changed"
 * on every run: the diff would say "realigning" even on an identical
 * definition, and `--overwrite` would rewrite everything every time.
 * `sameValue` normalises before comparing — these tests pin how far that
 * normalisation goes.
 */
describe('computeSeedDiff — comparing graph against seed', () => {
  const onlyNew: SeedableWorkflow = { ...FACTORY, steps: [FACTORY.steps[0]], transitions: [] }
  const live = (metadata: Record<string, unknown>) => [{
    name: 'new', label: 'Nuovo', type: 'start', enterActions: '[]', exitActions: '[]', metadata,
  }]
  const stepDiff = (metadata: Record<string, unknown>) =>
    computeSeedDiff(onlyNew, { version: 1, active: true, category: null }, live(metadata), []).stepsChanged

  it('a Neo4j Integer and the seed number are the SAME value', () => {
    expect(stepDiff({ step_order: neo4jInt(1), category: 'active' })).toEqual([])
  })

  it('an object that LOOKS like an Integer but is not does not break the diff: it compares as text', () => {
    // `toNumber` rejects a `{low, high}` that is not a real driver Integer:
    // the comparison falls back to String(), which here reports the
    // difference instead of letting the exception escape into the diff.
    const c = stepDiff({ step_order: { low: 1, high: 0 }, category: 'active' })
    expect(c).toHaveLength(1)
    expect(c[0].fields[0]).toContain('step_order')
  })

  it('a value absent from the graph and a value in the seed differ (and vice versa)', () => {
    expect(stepDiff({ category: 'active' })[0].fields[0]).toContain('step_order undefined → 1')
  })

  it('a boolean from the graph and the seed string match: the fallback is textual', () => {
    const withPurpose: SeedableWorkflow = {
      ...onlyNew,
      steps: [{ ...FACTORY.steps[0], metadata: { step_order: 1, category: 'active', purpose: 'true' } }],
    }
    const c = computeSeedDiff(withPurpose, { version: 1, active: true, category: null },
      live({ step_order: 1, category: 'active', purpose: true }), [])
    expect(c.stepsChanged).toEqual([])
  })

  it('version, active and category of the definition land in definitionFields', () => {
    const d = computeSeedDiff(onlyNew, { version: 9, active: false, category: 'hardware' }, live({ step_order: 1, category: 'active' }), [])
    expect(d.definitionFields).toEqual([
      'version 9 → 1',
      'active false → true',
      'category hardware → null',
    ])
  })

  it('step actions compare as JSON, and a step with no actions in the graph counts as "[]"', () => {
    const withAction: SeedableWorkflow = {
      ...onlyNew,
      steps: [{ ...FACTORY.steps[0], enterActions: [{ type: 'set_priority', params: { priority: 'high' } }] as never }],
    }
    const c = computeSeedDiff(withAction, { version: 1, active: true, category: null },
      [{ name: 'new', label: 'Nuovo', type: 'start', enterActions: null, exitActions: null, metadata: { step_order: 1, category: 'active' } }], [])
    expect(c.stepsChanged[0].fields.join(' ')).toContain('enter_actions [] → [{"type":"set_priority"')
  })

  it('a transition with the same from/to but a different trigger is ANOTHER transition', () => {
    // The comparison key includes the trigger: turning `manual` into
    // `automatic` is not "a changed transition", it is one removed and one added.
    const d = computeSeedDiff(FACTORY, { version: 1, active: true, category: null }, LIVE_STEPS.map((s) => ({ ...s, metadata: s.props })),
      [{ ...LIVE_TRS[0], trigger: 'automatic' }])
    expect(d.transitionsAdded).toEqual(['new → escalated [manual]'])
    expect(d.transitionsRemoved).toEqual(['new → escalated [automatic]'])
    expect(d.transitionsChanged).toEqual([])
  })

  it('a null trigger in the graph reads as "?" instead of vanishing from the line', () => {
    const d = computeSeedDiff(onlyNew, { version: 1, active: true, category: null }, live({ step_order: 1, category: 'active' }),
      [{ fromStepName: 'new', toStepName: 'closed', trigger: null, label: null, condition: null, requiresInput: null, inputField: null }])
    expect(d.transitionsRemoved).toEqual(['new → closed [?]'])
  })

  it('label, condition, requires_input and input_field of a transition land in the diff', () => {
    const d = computeSeedDiff(FACTORY, { version: 1, active: true, category: null }, LIVE_STEPS.map((s) => ({ ...s, metadata: s.props })),
      [{ fromStepName: 'new', toStepName: 'escalated', trigger: 'manual', label: 'Old', condition: 'x != null', requiresInput: true, inputField: 'notes' }])
    expect(d.transitionsChanged[0].fields).toEqual([
      'label "Old" → "Escalate"',
      'condition x != null → null',
      'requires_input true → false',
      'input_field notes → null',
    ])
  })

  it('a seed step ABSENT from the graph counts as added, not as changed', () => {
    const d = computeSeedDiff(FACTORY, { version: 1, active: true, category: null },
      [{ name: 'new', label: 'Nuovo', type: 'start', enterActions: '[]', exitActions: '[]', metadata: { step_order: 1, category: 'active' } }], [])
    expect(d.stepsAdded).toEqual(['escalated'])
    expect(d.stepsChanged).toEqual([])
  })

  it('label, type and EXIT actions of a step land in the diff', () => {
    const changed: SeedableWorkflow = {
      ...FACTORY,
      steps: [{ ...FACTORY.steps[0], label: 'Aperto', type: 'standard', exitActions: [{ type: 'sla_stop', params: {} }] as never }],
      transitions: [],
    }
    const d = computeSeedDiff(changed, { version: 1, active: true, category: null },
      [{ name: 'new', label: 'Nuovo', type: 'start', enterActions: '[]', exitActions: '[]', metadata: { step_order: 1, category: 'active' } }], [])
    expect(d.stepsChanged[0].fields).toEqual([
      'label "Nuovo" → "Aperto"',
      'type "start" → "standard"',
      'exit_actions [] → [{"type":"sla_stop","params":{}}]',
    ])
  })

  it('a seed step with no metadata compares none of them', () => {
    const without: SeedableWorkflow = { ...FACTORY, steps: [{ ...FACTORY.steps[0], metadata: undefined }], transitions: [] }
    expect(computeSeedDiff(without, { version: 1, active: true, category: null },
      [{ name: 'new', label: 'Nuovo', type: 'start', enterActions: '[]', exitActions: '[]', metadata: { step_order: 1, category: 'active' } }], []).stepsChanged).toEqual([])
  })
})

describe('formatSeedDiff — the lines the operator reads before --overwrite', () => {
  it('an empty diff says so, and prints no detail line', () => {
    const d = computeSeedDiff(FACTORY, { version: 1, active: true, category: null },
      FACTORY.steps.map((s) => ({ name: s.name, label: s.label, type: s.type, enterActions: '[]', exitActions: '[]', metadata: s.metadata as Record<string, unknown> })),
      [...FACTORY.transitions])
    const lines = formatSeedDiff('Incident Management', 'c-one', d)
    expect(seedDiffIsEmpty(d)).toBe(true)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('nessuna differenza')
  })

  it('every kind of difference has its sign: ~ changed, + added, - removed', () => {
    const d = computeSeedDiff(FACTORY, { version: 3, active: true, category: null },
      LIVE_STEPS.map((s) => ({ ...s, metadata: s.props })), LIVE_TRS)
    const lines = formatSeedDiff('Incident Management', 'c-one', d).join('\n')
    expect(lines).toContain('~ definizione: version 3 → 1')
    expect(lines).toContain('- passo "triage_cliente"')
    expect(lines).toContain('- transizione new → triage_cliente [manual]')
    expect(lines).toContain('~ passo "escalated": enter_actions')
  })

  it('added steps, added transitions and changed transitions each get their line', () => {
    const lines = formatSeedDiff('Incident Management', 'c-one', {
      definitionFields: [], stepsAdded: ['triage'], stepsRemoved: [], stepsChanged: [],
      transitionsAdded: ['new → triage [manual]'], transitionsRemoved: [],
      transitionsChanged: [{ key: 'new → escalated [manual]', fields: ['label "A" → "B"'] }],
    }).join('\n')
    expect(lines).toContain('  + passo "triage"')
    expect(lines).toContain('  + transizione new → triage [manual]')
    expect(lines).toContain('  ~ transizione new → escalated [manual]: label "A" → "B"')
  })
})

/**
 * THE WRITE, AFTER THE DIFF: the four ways a seed STOPS.
 *
 * Everything below actually writes (`overwrite: true`), and this is the path
 * where a wrong seed does damage: it deletes a step somebody is sitting on,
 * creates fewer transitions than it declares, or writes a key onto the node
 * that is not a metadata key. Each of these must stop BEFORE leaving the
 * graph half-written, not after.
 */
describe('seedWorkflowDefinition — where the write stops', () => {
  /** Like `fakeSession`, but with the removable-steps and created-transitions answers swappable. */
  function writingSession(over: { toRemove?: Record<string, unknown>[]; transitionsCreated?: number } = {}) {
    const queries: string[] = []
    const txRun = vi.fn(async (cypher: string, _params: Record<string, unknown> = {}) => {
      queries.push(cypher)
      if (cypher.includes('RETURN wd.id AS id, wd.version AS version')) return rows([])
      if (cypher.includes('MERGE (wd:WorkflowDefinition'))              return rows([{ id: 'def-new' }])
      if (cypher.includes('RETURN s.name AS name, count(wi) AS live'))  return rows(over.toRemove ?? [])
      if (cypher.includes('CREATE (from)-[:TRANSITIONS_TO'))            return rows([{ n: over.transitionsCreated ?? FACTORY.transitions.length }])
      if (cypher.includes('RETURN count(wi) AS n'))                     return rows([{ n: 2 }])
      return rows([])
    })
    return { queries, txRun, executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })) }
  }
  const deletes = (q: string[]) => q.some((c) => c.includes('DETACH DELETE s'))

  it('a step dropped from the seed but SAT ON by an instance stops everything and names it', async () => {
    const s = writingSession({ toRemove: [{ name: 'triage_cliente', live: 3 }] })
    await expect(seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwrite: true }))
      .rejects.toThrow(/triage_cliente.*running instances/)
    expect(deletes(s.queries)).toBe(false)
  })

  it('a step dropped from the seed with NO instances is deleted', async () => {
    const s = writingSession({ toRemove: [{ name: 'triage_cliente', live: 0 }] })
    const r = await seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwrite: true })
    expect(deletes(s.queries)).toBe(true)
    expect(r.relinked).toBe(2)
  })

  it('nothing to drop: no DETACH DELETE (we do not run "delete everything not in the seed" for nothing)', async () => {
    const s = writingSession({ toRemove: [] })
    await seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwrite: true })
    expect(deletes(s.queries)).toBe(false)
  })

  it('fewer transitions created than the seed declares: it stops and says WHICH ones point at a missing step', async () => {
    // A CREATE on an empty MATCH is not an error for Neo4j: without this
    // check the workflow would be left silently truncated.
    const truncated: SeedableWorkflow = {
      ...FACTORY,
      transitions: [...FACTORY.transitions, { id: 'tr-x', fromStepName: 'new', toStepName: 'missing', trigger: 'manual', label: 'X', condition: null, requiresInput: false, inputField: null }],
    }
    const s = writingSession({ transitionsCreated: 1 })
    await expect(seedWorkflowDefinition('c-one', truncated, { session: s as never, overwrite: true }))
      .rejects.toThrow(/created 1 transitions out of 2.*new→missing/)
  })

  it('a reserved or non-snake_case metadata key is refused, naming seed, step and key', async () => {
    for (const bad of ['tenant_id', 'Step_Order', 'enter_actions']) {
      const dirty: SeedableWorkflow = {
        ...FACTORY,
        steps: [{ ...FACTORY.steps[0], metadata: { [bad]: 'x' } }, FACTORY.steps[1]],
      }
      await expect(seedWorkflowDefinition('c-one', dirty, { session: writingSession() as never, overwrite: true }))
        .rejects.toThrow(`Seed "Incident Management", step "new": metadata key not allowed "${bad}"`)
    }
  })

  it('a step WITHOUT metadata passes: absent does not mean wrong', async () => {
    const without: SeedableWorkflow = { ...FACTORY, steps: FACTORY.steps.map((s) => ({ ...s, metadata: undefined })) }
    const s = writingSession()
    await expect(seedWorkflowDefinition('c-one', without, { session: s as never, overwrite: true })).resolves.toBeTruthy()
  })

  /**
   * On overwrite the seed-governed keys that are ABSENT are set to `null` (in
   * Cypher: removed). Without that, a `deadline` dropped from the seed stayed
   * on the node and kept firing (E-30).
   */
  it('--overwrite clears the governed keys the seed does not carry; a plain seed clears nothing', async () => {
    const readSteps = (s: ReturnType<typeof writingSession>) =>
      (s.txRun.mock.calls.find((c) => String(c[0]).includes('MERGE (s:WorkflowStep'))?.[1] as { steps: { name: string; clear: Record<string, unknown> }[] }).steps

    const withOverwrite = writingSession()
    await seedWorkflowDefinition('c-one', FACTORY, { session: withOverwrite as never, overwrite: true })
    expect(readSteps(withOverwrite)[0].clear).toEqual({
      is_initial: null, is_terminal: null, is_open: null, purpose: null, deadline: null,
    })

    const withoutOverwrite = writingSession()
    await seedWorkflowDefinition('c-two', FACTORY, { session: withoutOverwrite as never })
    expect(readSteps(withoutOverwrite)[0].clear).toEqual({})
  })
})

/**
 * "UNKNOWN USER" AND THE OTHER FALLBACKS.
 *
 * `customized_by` can be missing: the mark was also written by a migration,
 * not only by the designer. The message must stay readable — "customized on …
 * by undefined" would send someone looking for a user who does not exist
 * instead of making it clear the author is not on record.
 */
describe('seedWorkflowDefinition — the message fallbacks', () => {
  const said = () => (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n')
  const marked = (customizedBy: string | null) =>
    fakeSession({ existing: { id: 'def-1', version: 3, active: true, category: null, customizedAt: '2026-09-01', customizedBy } })

  it('refusing the overwrite says "utente sconosciuto" when the author is not on record', async () => {
    await expect(seedWorkflowDefinition('c-one', FACTORY, { session: marked(null) as never, overwrite: true }))
      .rejects.toThrow(/il 2026-09-01 da utente sconosciuto — l'overwrite si rifiuta/)
  })

  it('skipping a marked definition with no author says the same', async () => {
    await seedWorkflowDefinition('c-one', FACTORY, { session: marked(null) as never })
    expect(said()).toContain('è stata personalizzata il 2026-09-01 da utente sconosciuto')
  })

  it('the --overwrite-customized warning says the same', async () => {
    await seedWorkflowDefinition('c-one', FACTORY, { session: marked(null) as never, overwriteCustomized: true })
    expect(said()).toContain('era marchiata come personalizzata (2026-09-01, utente sconosciuto)')
  })

  it('a graph step with no properties() reads as "no metadata" and does not break the diff', async () => {
    // `properties(s)` never comes back undefined from Neo4j, but the diff
    // also runs on rows built elsewhere (tests, migrations): no metadata is
    // better than a TypeError inside the comparison.
    const s = fakeSession()
    s.txRun.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN wd.id AS id, wd.version AS version')) return rows([{ id: 'def-1', version: 1, active: true, category: null, customizedAt: null, customizedBy: null }])
      if (cypher.includes('RETURN s.name AS name, s.label AS label')) return rows([{ name: 'new', label: 'Nuovo', type: 'start', enterActions: '[]', exitActions: '[]', props: undefined }])
      if (cypher.includes('RETURN from.name AS fromStepName')) return rows([])
      if (cypher.includes('MERGE (wd:WorkflowDefinition')) return rows([{ id: 'def-1' }])
      if (cypher.includes('CREATE (from)-[:TRANSITIONS_TO')) return rows([{ n: FACTORY.transitions.length }])
      if (cypher.includes('RETURN count(wi) AS n')) return rows([{ n: 0 }])
      return rows([])
    })
    const r = await seedWorkflowDefinition('c-one', FACTORY, { session: s as never, overwrite: true })
    expect(r.diff?.stepsChanged[0]).toMatchObject({ name: 'new', fields: ['step_order undefined → 1', 'category undefined → active'] })
  })

  it('fewer transitions created with no step actually missing: the message points at the names instead of trailing off', async () => {
    // This happens with two identical transitions in the seed: every step is
    // there, but the CREATE produces only one. "missing steps in: " and
    // nothing else would tell the reader nothing.
    const duplicated: SeedableWorkflow = { ...FACTORY, transitions: [FACTORY.transitions[0], { ...FACTORY.transitions[0], id: 'tr-bis' }] }
    const s = fakeSession({ existing: null })
    await expect(seedWorkflowDefinition('c-one', duplicated, { session: s as never }))
      .rejects.toThrow(/created 1 transitions out of 2 — missing steps in: \(see step names\)/)
  })
})

/**
 * Whoever runs a seed from a script has no session: the seed opens one, and
 * it MUST close it — including when the write fails. An unclosed Neo4j
 * session holds a pool connection: a handful of failed seeds is enough to
 * exhaust it, and the next process hangs trying to open one.
 */
describe('seedWorkflowDefinition — the session it opens itself, it closes itself', () => {
  function ownSession(outcome: 'ok' | 'ko') {
    const close = vi.fn(async () => {})
    const txRun = vi.fn(async (cypher: string) => {
      if (outcome === 'ko') throw new Error('Neo4j down')
      if (cypher.includes('RETURN wd.id AS id, wd.version AS version')) return rows([])
      if (cypher.includes('MERGE (wd:WorkflowDefinition'))              return rows([{ id: 'def-new' }])
      if (cypher.includes('CREATE (from)-[:TRANSITIONS_TO'))            return rows([{ n: FACTORY.transitions.length }])
      if (cypher.includes('RETURN count(wi) AS n'))                     return rows([{ n: 0 }])
      return rows([])
    })
    return { close, executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })) }
  }

  it('with no session it opens one for writing and closes it', async () => {
    const s = ownSession('ok')
    fakeGetSession.mockReturnValue(s)
    const r = await seedWorkflowDefinition('c-two', FACTORY)
    expect(fakeGetSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(r.created).toBe(true)
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('it closes it even when the write fails', async () => {
    const s = ownSession('ko')
    fakeGetSession.mockReturnValue(s)
    await expect(seedWorkflowDefinition('c-two', FACTORY)).rejects.toThrow('Neo4j down')
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('a session PASSED by the caller is not closed: it is theirs, and they are still using it', async () => {
    const s = ownSession('ok')
    await seedWorkflowDefinition('c-two', FACTORY, { session: s as never })
    expect(s.close).not.toHaveBeenCalled()
  })
})
