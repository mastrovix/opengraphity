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
