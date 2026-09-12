/**
 * Personalizzazioni, ondata 2 — le scritture del disegnatore di workflow.
 *
 * - B2-1 (B-3): `addWorkflowStep` scrive `tenant_id` e i metadata, e rifiuta un
 *   nome già usato nella stessa definizione.
 * - B2-2 (B-1): `removeWorkflowStep` rifiuta se ci sono istanze su quel passo
 *   (dicendo quante e in che stato) e se il passo è quello iniziale.
 * - B2-3 (B-8): `saveWorkflowChanges` rifiuta «iniziale» su un passo terminale.
 * - B2-4 (B-24): ogni mutation invalida la cache dei metadata dei passi.
 * - Contratto con i seed: ogni mutation che tocca la configurazione di processo
 *   marchia la definizione (`customized_at`/`customized_by`); il LAYOUT no.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

// ── Sessione finta che ESEGUE le callback e registra il Cypher ────────────────

interface Call { cypher: string; params: Record<string, unknown>; mode: 'read' | 'write' }

const calls: Call[] = []
let results: Array<{ records: Array<{ get: (k: string) => unknown }> }> = []

const makeRecord = (map: Record<string, unknown>) => ({
  get: (key: string) => (key in map ? map[key] : null),
})

function nextResult() {
  return results.shift() ?? { records: [] }
}

const mockSession = {
  executeRead:  vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async (cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params, mode: 'read' }); return nextResult() },
  })),
  executeWrite: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async (cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params, mode: 'write' }); return nextResult() },
  })),
  close: vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/events', () => ({ publish: vi.fn().mockResolvedValue(undefined), getRedisOptions: vi.fn(() => ({})) }))

const WORKFLOW_ACTION_TYPES_MOCK = ['publish_event', 'notify_rule'] as const
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), registerCondition: vi.fn(), getAvailableTransitions: vi.fn() },
  WORKFLOW_ACTION_TYPES: WORKFLOW_ACTION_TYPES_MOCK,
  isWorkflowActionType: (t: unknown) => typeof t === 'string' && (WORKFLOW_ACTION_TYPES_MOCK as readonly string[]).includes(t),
}))
vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: vi.fn() } }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  getSession: vi.fn(),
}))
vi.mock('../../../services/incidentService.js', () => ({ publishIncidentTransition: vi.fn() }))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  workflowLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/validateRequiredFields.js', () => ({ validateRequiredFields: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ invalidateWorkflowCache: vi.fn() }))

const { workflowResolvers } = await import('../workflow.js')
const { invalidateWorkflowCache } = await import('../../../lib/workflowHelpers.js')

const M = workflowResolvers.Mutation
const ctx: GraphQLContext = { tenantId: 'c-two', userId: 'user-1', userEmail: 'u@test.io', role: 'admin' }

/** Ogni Cypher scritto in questa chiamata, concatenato. */
const writtenCypher = () => calls.filter((c) => c.mode === 'write').map((c) => c.cypher).join('\n---\n')
const paramsOf = (needle: string) => calls.find((c) => c.cypher.includes(needle))?.params

beforeEach(() => {
  calls.length = 0
  results = []
  vi.clearAllMocks()
})

// ── B2-1 — addWorkflowStep ────────────────────────────────────────────────────

describe('addWorkflowStep (B2-1 / B-3): il passo nasce con il dato completo', () => {
  it('scrive tenant_id, i flag, la categoria e step_order = max+1', async () => {
    results = [{ records: [makeRecord({ entityType: 'incident' })] }]
    await M.addWorkflowStep(null, { definitionId: 'def-1', name: 'standard_attesa_x', label: 'Attesa', type: 'standard' }, ctx)

    const cypher = writtenCypher()
    expect(cypher).toContain('tenant_id:           $tenantId')
    expect(cypher).toContain('is_initial:          false')
    expect(cypher).toContain('is_terminal:         false')
    expect(cypher).toContain('is_open:             true')
    expect(cypher).toContain('step_order:          nextOrder')
    expect(cypher).toContain('coalesce(max(ex.step_order), 0) + 1')
    expect(cypher).toContain('created_at:          $now')
    const params = paramsOf('CREATE (s:WorkflowStep')!
    expect(params['tenantId']).toBe('c-two')
    expect(params['category']).toBe('active')
  })

  it('marchia la definizione come personalizzata e invalida la cache', async () => {
    results = [{ records: [makeRecord({ entityType: 'incident' })] }]
    await M.addWorkflowStep(null, { definitionId: 'def-1', name: 'x', label: 'X', type: 'standard' }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
    expect(paramsOf('customized_at')!['customizedBy']).toBe('user-1')
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('c-two', 'incident')
  })

  it('0 righe (definizione di un altro tenant o nome già usato) → errore, niente cache invalidata', async () => {
    results = [{ records: [] }]
    await expect(M.addWorkflowStep(null, { definitionId: 'def-1', name: 'assigned', label: 'X', type: 'standard' }, ctx))
      .rejects.toThrow(/nome già usato/)
    expect(invalidateWorkflowCache).not.toHaveBeenCalled()
  })

  it('tipo di step fuori vocabolario → nessuna scrittura', async () => {
    await expect(M.addWorkflowStep(null, { definitionId: 'def-1', name: 'x', label: 'X', type: 'teleport' }, ctx))
      .rejects.toThrow('Invalid step type: teleport')
    expect(calls).toHaveLength(0)
  })
})

// ── B2-2 — removeWorkflowStep ────────────────────────────────────────────────

describe('removeWorkflowStep (B2-2 / B-1): non si cancella un passo con dei ticket sopra', () => {
  const stepRow = (over: Record<string, unknown> = {}) => makeRecord({
    type: 'standard', isInitial: false, entityType: 'incident', instanceStatus: null, n: 0, ...over,
  })

  it('istanze sul passo → CONFLICT che dice quante e in che stato, e NESSUNA cancellazione', async () => {
    results = [{ records: [
      stepRow({ instanceStatus: 'active', n: 148 }),
      stepRow({ instanceStatus: 'suspended', n: 2 }),
    ] }]
    const err = await M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'assigned' }, ctx).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('CONFLICT')
    expect((err as GraphQLError).message).toContain('150 istanze')
    expect((err as GraphQLError).message).toContain('active: 148')
    expect((err as GraphQLError).message).toContain('suspended: 2')
    expect(writtenCypher()).not.toContain('DETACH DELETE')
    expect(invalidateWorkflowCache).not.toHaveBeenCalled()
  })

  it('nessuna istanza → cancella, marchia la definizione e invalida la cache', async () => {
    results = [{ records: [stepRow()] }, { records: [] }]
    await M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'pending' }, ctx)
    expect(writtenCypher()).toContain('DETACH DELETE')
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('c-two', 'incident')
  })

  it('passo iniziale → rifiutato (il processo non potrebbe più partire)', async () => {
    results = [{ records: [stepRow({ isInitial: true })] }]
    await expect(M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'new' }, ctx))
      .rejects.toThrow(/step iniziale del processo/)
    expect(writtenCypher()).not.toContain('DETACH DELETE')
  })

  /**
   * `start`/`end` sono protetti per `type`, e questo è il PRIMO rifiuto che
   * l'amministratore incontra: il passo di partenza è quasi sempre anche
   * `type: 'start'`. Il messaggio era «Cannot remove step: new», che non dice
   * niente — in un'ondata il cui punto è «il disegnatore spiega perché».
   */
  it('passo di tipo start/end → rifiutato dicendo perché, senza cancellare', async () => {
    for (const type of ['start', 'end']) {
      results = [{ records: [stepRow({ type, isInitial: false })] }]
      const err = await M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'new' }, ctx).then(() => null, (e: unknown) => e)
      expect((err as GraphQLError).message).toMatch(/i passi di apertura e di chiusura del processo non si eliminano/)
      expect((err as GraphQLError).message).toContain(`"${type}"`)
      expect((err as GraphQLError).message).not.toMatch(/^Cannot remove step/)
      expect(writtenCypher()).not.toContain('DETACH DELETE')
    }
  })

  it('passo inesistente → errore esplicito, non «Cannot remove step»', async () => {
    results = [{ records: [] }]
    await expect(M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'fantasma' }, ctx))
      .rejects.toThrow(/non trovato in questa definizione/)
  })
})

// ── B2-3 — saveWorkflowChanges: iniziale e terminale non stanno insieme ───────

describe('saveWorkflowChanges (B2-3 / B-8): lo step iniziale non può essere terminale', () => {
  const base = { definitionId: 'def-1', transitions: [], positions: [], expectedVersion: null }
  const step = (over: Record<string, unknown> = {}) => ({
    stepName: 'closed', label: 'Chiuso', enterActions: null, exitActions: null, ...over,
  })

  it('iniziale su un passo già terminale nel grafo → rifiutato prima di scrivere i passi', async () => {
    results = [
      { records: [makeRecord({ version: 3 })] },          // lettura versione
      { records: [makeRecord({ terminal: true })] },       // il passo è terminale
    ]
    await expect(M.saveWorkflowChanges(null, { ...base, steps: [step({ isInitial: true })] }, ctx))
      .rejects.toThrow(/è terminale: non può essere anche lo step iniziale/)
    expect(writtenCypher()).not.toContain('SET s.label')
  })

  it('iniziale e terminale nella STESSA chiamata → rifiutato', async () => {
    results = [
      { records: [makeRecord({ version: 3 })] },
      { records: [makeRecord({ terminal: false })] },
    ]
    await expect(M.saveWorkflowChanges(null, { ...base, steps: [step({ isInitial: true, isTerminal: true })] }, ctx))
      .rejects.toThrow(/non può essere anche lo step iniziale/)
  })

  it('due passi marcati iniziali → rifiutato dicendo quali', async () => {
    results = [{ records: [makeRecord({ version: 3 })] }]
    await expect(M.saveWorkflowChanges(null, {
      ...base,
      steps: [step({ stepName: 'a', isInitial: true }), step({ stepName: 'b', isInitial: true })],
    }, ctx)).rejects.toThrow(/Un solo step può essere iniziale.*a, b/s)
  })

  it('iniziale su un passo non terminale → passa, marchia la definizione, invalida la cache', async () => {
    results = [
      { records: [makeRecord({ version: 3 })] },
      { records: [makeRecord({ terminal: false })] },
      { records: [] },                                     // SET dei passi
      { records: [] },                                     // demozione degli altri
      { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'incident', version: 4 } } })] },
      { records: [] },                                     // rilettura passi
    ]
    await M.saveWorkflowChanges(null, { ...base, steps: [step({ stepName: 'assigned', isInitial: true })] }, ctx)
    expect(writtenCypher()).toContain('SET s.label')
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('c-two', 'incident')
  })

  /**
   * Regressione: il parametro `transitions` non era destrutturato e il
   * `transitions.length` dentro la transazione leggeva la variabile locale
   * dichiarata DOPO (zona morta temporale) → ReferenceError su OGNI
   * salvataggio del disegnatore.
   */
  it('le transizioni mandate dal client vengono davvero scritte', async () => {
    results = [
      { records: [makeRecord({ version: 1 })] },
      { records: [] },                                     // UNWIND transizioni
      { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'incident' } } })] },
      { records: [] },
    ]
    await M.saveWorkflowChanges(null, {
      ...base,
      steps: null,
      transitions: [{ transitionId: 'tr-1', label: 'Assegna', trigger: 'manual', requiresInput: false, inputField: null, condition: null, timerHours: null }],
    }, ctx)
    expect(writtenCypher()).toContain('UNWIND $transitions AS tr')
    expect(paramsOf('UNWIND $transitions')!['transitions']).toHaveLength(1)
  })
})

// ── Contratto con i seed: chi marchia e chi no ───────────────────────────────

describe('marchio di personalizzazione (contratto con i seed)', () => {
  it('addWorkflowTransition, removeWorkflowTransition e updateWorkflowTransition marchiano', async () => {
    results = [{ records: [makeRecord({ tr: { properties: { trigger: 'manual', label: 'x' } }, fromStep: 'a', toStep: 'b', entityType: 'incident' })] }]
    await M.addWorkflowTransition(null, { definitionId: 'def-1', fromStepName: 'a', toStepName: 'b' }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')

    calls.length = 0
    results = [{ records: [makeRecord({ deletedId: 'tr-1', entityType: 'incident' })] }]
    await M.removeWorkflowTransition(null, { definitionId: 'def-1', transitionId: 'tr-1' }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')

    calls.length = 0
    results = [
      { records: [] },
      { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'incident' } }, steps: [] })] },
    ]
    await M.updateWorkflowTransition(null, {
      definitionId: 'def-1', transitionId: 'tr-1',
      input: { requiresInput: false },
    }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
  })

  it('updateWorkflowStep marchia e invalida la cache', async () => {
    results = [{ records: [makeRecord({ s: { properties: { id: 's1', name: 'assigned', label: 'L', type: 'standard' } }, entityType: 'incident' })] }]
    await M.updateWorkflowStep(null, { definitionId: 'def-1', stepName: 'assigned', label: 'L' }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('c-two', 'incident')
  })

  it('saveWorkflowLayout NON marchia: la posizione sul canvas non è configurazione di processo', async () => {
    await M.saveWorkflowLayout(null, { definitionId: 'def-1', positions: [{ stepId: 's1', positionX: 1, positionY: 2 }] }, ctx)
    expect(writtenCypher()).not.toContain('customized_at')
    expect(invalidateWorkflowCache).not.toHaveBeenCalled()
  })
})
