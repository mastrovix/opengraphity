/**
 * Personalizzazioni, ondata 4 — B4-3: lo SCOPO del passo si assegna dal
 * disegnatore, ed è l'unica via per farlo.
 *
 * Il vocabolario è chiuso (`WORKFLOW_STEP_PURPOSES`): uno scopo inventato è
 * rifiutato **prima di scrivere**, nominando i valori ammessi. Un passo senza
 * scopo è legittimo, quindi lo scopo si deve poter anche TOGLIERE: la stringa
 * vuota lo rimuove, l'assenza del campo lo lascia com'è (un `coalesce` lo
 * renderebbe irreversibile). Il codice di produzione non indovina mai lo scopo
 * dal nome del passo — `FACTORY_STEP_PURPOSES` è solo del seed e della
 * migrazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { WORKFLOW_STEP_PURPOSES } from '@opengraphity/types'
import type { GraphQLContext } from '../../../context.js'

interface Call { cypher: string; params: Record<string, unknown>; mode: 'read' | 'write' }
const calls: Call[] = []
let results: Array<{ records: Array<{ get: (k: string) => unknown }> }> = []
const makeRecord = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })
const nextResult = () => results.shift() ?? { records: [] }

const mockSession = {
  executeRead:  vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async (cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params, mode: 'read' }); return nextResult() },
  })),
  executeWrite: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async (cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params, mode: 'write' }); return nextResult() },
  })),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('@opengraphity/events', () => ({ publish: vi.fn().mockResolvedValue(undefined), getRedisOptions: vi.fn(() => ({})) }))
const ACTIONS = ['publish_event', 'notify_rule'] as const
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), registerCondition: vi.fn(), getAvailableTransitions: vi.fn() },
  WORKFLOW_ACTION_TYPES: ACTIONS,
  isWorkflowActionType: (t: unknown) => typeof t === 'string' && (ACTIONS as readonly string[]).includes(t),
}))
vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: vi.fn() } }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  getSession: vi.fn(),
}))
vi.mock('../../../services/incidentService.js', () => ({ publishIncidentTransition: vi.fn() }))
// Revisione delle otto ondate · B·N-1: togliere lo scopo a un passo di un
// workflow delle change fa scattare la guardia che verifica che resti un posto
// dove approvare, e quella legge i tipi di change pre-approvati del cliente.
vi.mock('../../../lib/changePolicy.js', () => ({
  preApprovedChangeTypes: vi.fn(async () => ['standard', 'normal', 'emergency']),
  changeTypeVocabulary:   vi.fn(async () => ['standard', 'normal', 'emergency']),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  workflowLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/validateRequiredFields.js', () => ({ validateRequiredFields: vi.fn().mockResolvedValue(undefined) }))
// Le scadenze dei passi (ondata 3) hanno i loro test (stepDeadlines.test.ts): qui la
// lettura del loro controllo sposterebbe i risultati in coda di questo doppio.
vi.mock('../../../lib/stepDeadlineWrite.js', async (importOriginal) => ({ ...(await importOriginal<object>()), assertDefinitionDeadlines: vi.fn(async () => {}) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ invalidateWorkflowCache: vi.fn() }))

const { normalizeStepPurpose, updateWorkflowStep, saveWorkflowChanges } = await import('../workflowMutations.js')

const ctx: GraphQLContext = { tenantId: 'c-two', userId: 'user-1', userEmail: 'u@test.io', role: 'admin' }
const paramsOf = (needle: string) => calls.find((c) => c.cypher.includes(needle))?.params
const cypherOf = (needle: string) => calls.find((c) => c.cypher.includes(needle))?.cypher ?? ''

beforeEach(() => { calls.length = 0; results = []; vi.clearAllMocks() })

describe('normalizeStepPurpose — vocabolario chiuso, e «nessuno scopo» è una scelta', () => {
  it('accetta ogni scopo del vocabolario', () => {
    for (const p of WORKFLOW_STEP_PURPOSES) expect(normalizeStepPurpose(p, 'x')).toBe(p)
  })

  it('rifiuta uno scopo inventato nominando i valori ammessi', () => {
    const err = (() => { try { normalizeStepPurpose('cab', 'step "cab_settimanale"') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toContain('cab_settimanale')
    expect((err as GraphQLError).message).toContain('implementation')
    expect((err as GraphQLError).extensions['allowedPurposes']).toEqual([...WORKFLOW_STEP_PURPOSES])
  })

  it('rifiuta un NOME di passo usato come scopo: `deployment` non è uno scopo', () => {
    expect(() => normalizeStepPurpose('deployment', 'x')).toThrow(/out of vocabulary/)
  })

  it('distingue «non mandato» (undefined/null) da «togli» (stringa vuota)', () => {
    expect(normalizeStepPurpose(undefined, 'x')).toBeUndefined()
    expect(normalizeStepPurpose(null, 'x')).toBeUndefined()
    expect(normalizeStepPurpose('', 'x')).toBeNull()
    expect(normalizeStepPurpose('   ', 'x')).toBeNull()
  })
})

describe('saveWorkflowChanges — lo scopo si scrive, si toglie e non si inventa', () => {
  const base = { definitionId: 'def-1', transitions: [], positions: [] }
  const step = (over: Record<string, unknown> = {}) => ({
    stepName: 'cab_settimanale', label: 'CAB settimanale', enterActions: null, exitActions: null, ...over,
  })

  it('scrive lo scopo del passo, senza coalesce (così si può anche togliere)', async () => {
    results = [
      { records: [makeRecord({ version: 3 })] },           // lettura della versione
      // Terza revisione · G2: le guardie scattano su QUALUNQUE cambio di scopo,
      // non solo sulla rimozione, quindi prima e dopo la scrittura si contano i
      // passi della finestra di rilascio.
      { records: [makeRecord({ n: 1 })] },                  // passi di finestra PRIMA
      { records: [] },                                      // UNWIND steps
      { records: [makeRecord({ approvalSteps: 1 })] },      // guardia dell'approvazione
      { records: [makeRecord({ n: 1 })] },                  // passi di finestra DOPO
      { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'change', version: 4 } } })] },
      { records: [] },
    ]
    await saveWorkflowChanges(null, { ...base, steps: [step({ purpose: 'approval' })], expectedVersion: 3 }, ctx)

    const p = paramsOf('UNWIND $steps AS st')!
    expect((p['steps'] as Array<Record<string, unknown>>)[0]).toMatchObject({ purpose: 'approval', purposeGiven: true })
    expect(cypherOf('UNWIND $steps AS st')).toContain('s.purpose       = CASE WHEN st.purposeGiven THEN st.purpose ELSE s.purpose END')
  })

  it('stringa vuota → lo scopo viene TOLTO (purpose null con purposeGiven true)', async () => {
    results = [
      { records: [makeRecord({ version: 1 })] },
      { records: [makeRecord({ n: 1 })] },                  // passi di finestra PRIMA
      { records: [] },
      // La guardia dell'ondata di rimedio 2: resta un altro passo con lo scopo
      // `approval`, quindi togliere questo è legittimo.
      { records: [makeRecord({ approvalSteps: 1 })] },
      { records: [makeRecord({ n: 1 })] },                  // passi di finestra DOPO
      { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'change', version: 2 } } })] }, { records: [] },
    ]
    await saveWorkflowChanges(null, { ...base, steps: [step({ purpose: '' })], expectedVersion: 1 }, ctx)
    expect((paramsOf('UNWIND $steps AS st')!['steps'] as Array<Record<string, unknown>>)[0])
      .toMatchObject({ purpose: null, purposeGiven: true })
  })

  it('campo assente → lo scopo salvato resta com\'è (purposeGiven false)', async () => {
    results = [
      { records: [makeRecord({ version: 1 })] }, { records: [] },
      { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'change', version: 2 } } })] }, { records: [] },
    ]
    await saveWorkflowChanges(null, { ...base, steps: [step()], expectedVersion: 1 }, ctx)
    expect((paramsOf('UNWIND $steps AS st')!['steps'] as Array<Record<string, unknown>>)[0])
      .toMatchObject({ purpose: null, purposeGiven: false })
  })

  it('uno scopo inventato è rifiutato PRIMA di aprire la transazione: nessuna scrittura', async () => {
    await expect(saveWorkflowChanges(null, { ...base, steps: [step({ purpose: 'cab' })], expectedVersion: 1 }, ctx))
      .rejects.toThrow(/out of vocabulary/)
    expect(calls).toHaveLength(0)
  })
})

describe('updateWorkflowStep — stessa convenzione', () => {
  it('scrive lo scopo e lo restituisce', async () => {
    results = [
      // Terza revisione · G2: con uno scopo indicato, `updateWorkflowStep`
      // conta i passi della finestra PRIMA, scrive, poi verifica le due guardie.
      { records: [makeRecord({ n: 1 })] },                  // passi di finestra PRIMA
      { records: [makeRecord({ s: { properties: { id: 's1', name: 'cab_settimanale', label: 'CAB', type: 'standard', purpose: 'approval' } }, entityType: 'change' })] },
      { records: [makeRecord({ approvalSteps: 1 })] },      // guardia dell'approvazione
      { records: [makeRecord({ n: 1 })] },                  // passi di finestra DOPO
    ]
    const out = await updateWorkflowStep(null, { definitionId: 'def-1', stepName: 'cab_settimanale', label: 'CAB', purpose: 'approval' }, ctx)
    expect(out.purpose).toBe('approval')
    const p = paramsOf('SET s.label')!
    expect(p['purposeGiven']).toBe(true)
    expect(p['purpose']).toBe('approval')
  })

  it('uno scopo inventato è rifiutato senza toccare il grafo', async () => {
    await expect(updateWorkflowStep(null, { definitionId: 'def-1', stepName: 'x', label: 'X', purpose: 'cab' }, ctx))
      .rejects.toThrow(/out of vocabulary/)
    expect(calls).toHaveLength(0)
  })
})
