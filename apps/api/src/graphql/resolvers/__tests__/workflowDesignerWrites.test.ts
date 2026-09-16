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
import { perms } from '../../../lib/__tests__/testPermissions.js'

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

// Le fotografie per l'Audit Log leggono il grafo: qui non consumano le risposte in coda delle query sotto prova.
vi.mock('../../../lib/workflowAuditDetails.js', () => ({
  workflowSnapshot: vi.fn().mockResolvedValue({ steps: {}, transitions: {} }),
  workflowChangeDetails: vi.fn(() => ({})),
}))
vi.mock('@opengraphity/events', () => ({ publish: vi.fn().mockResolvedValue(undefined), getRedisOptions: vi.fn(() => ({})) }))

const WORKFLOW_ACTION_TYPES_MOCK = ['publish_event', 'notify_rule'] as const
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), registerCondition: vi.fn(), getAvailableTransitions: vi.fn() },
  WORKFLOW_ACTION_TYPES: WORKFLOW_ACTION_TYPES_MOCK,
  isWorkflowActionType: (t: unknown) => typeof t === 'string' && (WORKFLOW_ACTION_TYPES_MOCK as readonly string[]).includes(t),
}))
vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: vi.fn() } }))
// Mock PARZIALE: le funzioni pure del pacchetto (`toNumber`, che converte gli
// Integer del driver) restano quelle vere. Sostituirle nasconderebbe proprio le
// conversioni che in passato hanno rotto `deleteEnumType`.
vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { ...orig, getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }
})
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  getSession: vi.fn(),
}))
vi.mock('../../../services/incidentService.js', () => ({ publishIncidentTransition: vi.fn() }))
const fakeLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fakeLog() })
vi.mock('../../../lib/logger.js', () => ({ logger: fakeLog(), workflowLogger: fakeLog() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/validateRequiredFields.js', () => ({ validateRequiredFields: vi.fn().mockResolvedValue(undefined) }))
// Le scadenze dei passi (ondata 3) hanno i loro test (stepDeadlines.test.ts): qui la
// lettura del loro controllo sposterebbe i risultati in coda di questo doppio.
vi.mock('../../../lib/stepDeadlineWrite.js', async (importOriginal) => ({ ...(await importOriginal<object>()), assertDefinitionDeadlines: vi.fn(async () => {}) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ invalidateWorkflowCache: vi.fn() }))
// I tipi di change pre-approvati: li legge la guardia che impedisce di lasciare
// il workflow delle change senza un posto dove approvare (revisione · B·N-1).
let preApprovedTypes: readonly string[] = ['standard']
let changeTypes:      readonly string[] = ['standard', 'normal', 'emergency']
vi.mock('../../../lib/changePolicy.js', () => ({
  preApprovedChangeTypes: vi.fn(async () => preApprovedTypes),
  changeTypeVocabulary:   vi.fn(async () => changeTypes),
}))

const { workflowResolvers } = await import('../workflow.js')
const { invalidateWorkflowCache } = await import('../../../lib/workflowHelpers.js')
const { workflowLogger } = await import('../../../lib/logger.js')
const { audit } = await import('../../../lib/audit.js')

const M = workflowResolvers.Mutation
const ctx: GraphQLContext = { tenantId: 'c-two', userId: 'user-1', userEmail: 'u@test.io', role: 'admin', permissions: perms('admin') }

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
      .rejects.toThrow(/the name is already used/)
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
    expect((err as GraphQLError).message).toContain('150 workflow instances')
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
      .rejects.toThrow(/initial step of the process/)
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
      expect((err as GraphQLError).message).toMatch(/the opening and closing steps of the process cannot be deleted/)
      expect((err as GraphQLError).message).toContain(`"${type}"`)
      expect((err as GraphQLError).message).not.toMatch(/^Cannot remove step/)
      expect(writtenCypher()).not.toContain('DETACH DELETE')
    }
  })

  it('passo inesistente → errore esplicito, non «Cannot remove step»', async () => {
    results = [{ records: [] }]
    await expect(M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'fantasma' }, ctx))
      .rejects.toThrow(/not found in this definition/)
  })

  // ── Ondata 8 · B-21: le regole di obbligatorietà del passo non restano orfane
  // Una regola «campo X obbligatorio entrando in questo passo» sopravviveva al
  // passo: il pannello continuava a mostrarla come attiva e non valeva per
  // nessuna transizione. Si cancella col passo, e lo si dice (log + audit).
  it('le regole di obbligatorietà del passo eliminato vengono rimosse, e il numero finisce nei log', async () => {
    results = [
      { records: [stepRow()] },                                             // lettura metadata
      { records: [makeRecord({ n: 0 })] },                                  // il passo non esiste in altre definizioni attive
      { records: [] },                                                      // DETACH DELETE
      { records: [makeRecord({ fields: ['planned_start', 'rollback_plan'] })] }, // regole rimosse
    ]
    await M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'pending' }, ctx)
    const cypher = writtenCypher()
    expect(cypher).toContain('MATCH (r:FieldRequirementRule {tenant_id: $tenantId, entity_type: $entityType, workflow_step: $stepName})')
    expect(workflowLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stepName: 'pending', fields: ['planned_start', 'rollback_plan'] }),
      expect.stringContaining('rimosse 2 regole di obbligatorietà'),
    )
    expect(audit).toHaveBeenCalledWith(ctx, 'fieldRequirementRule.orphansRemoved', 'WorkflowStep', 'pending', expect.anything())
  })

  it('lo stesso nome di passo esiste in un\'altra definizione attiva (variante per categoria) → le regole restano', async () => {
    results = [
      { records: [stepRow()] },
      { records: [makeRecord({ n: 1 })] },   // c'è anche nella variante «Incident — Security»
      { records: [] },
    ]
    await M.removeWorkflowStep(null, { definitionId: 'def-1', stepName: 'security_review' }, ctx)
    expect(writtenCypher()).not.toContain('FieldRequirementRule')
    expect(audit).not.toHaveBeenCalledWith(ctx, 'fieldRequirementRule.orphansRemoved', expect.anything(), expect.anything(), expect.anything())
  })
})

/**
 * Ondata 8: le mutation che cambiano la definizione incrementano la VERSIONE.
 * Quattro non lo facevano (modifica di un passo e le tre sulle transizioni), e
 * il lock ottimistico del disegnatore confronta le versioni: due sessioni
 * aperte sullo stesso workflow non si accorgevano di quelle modifiche, e
 * l'ultima salvava sopra l'altra in silenzio.
 */
describe('la versione della definizione si muove a ogni modifica (ondata 8)', () => {
  it('aggiungere, modificare e togliere una transizione incrementano wd.version', async () => {
    /**
     * CONTRATTO RINEGOZIATO (revisione totale · B-26/B-27):
     *  - `addWorkflowTransition` interroga PRIMA il grafo per rifiutare un
     *    arco identico (stessa coppia di passi, stesso innesco): la prima
     *    risposta del mock deve dire «nessun duplicato».
     *  - `updateWorkflowTransition` vuole la definizione, perché la
     *    transizione deve essere di QUELLA definizione e non di un'altra
     *    dello stesso tenant.
     */
    for (const run of [
      () => M.addWorkflowTransition(null, { definitionId: 'def-1', fromStepName: 'a', toStepName: 'b', trigger: 'manual' }, ctx),
      () => M.updateWorkflowTransition(null, { definitionId: 'def-1', transitionId: 't-1', input: { requiresInput: false, label: 'x' } }, ctx),
      () => M.removeWorkflowTransition(null, { definitionId: 'def-1', transitionId: 't-1' }, ctx),
    ]) {
      results = [
        { records: [] },   // nessun arco identico / nessuna riga da leggere
        { records: [makeRecord({ tr: { properties: { id: 't-1' } }, fromStep: 'a', toStep: 'b', entityType: 'incident', deletedId: 't-1', id: 't-1' })] },
        { records: [] },
      ]
      await run().catch(() => undefined)   // alcune rispondono NOT_FOUND col mock minimo: conta il Cypher
      expect(writtenCypher(), 'la versione deve essere incrementata').toContain('wd.version = wd.version + 1')
      expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
    }
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
      .rejects.toThrow(/is terminal: it cannot also be the initial step/)
    expect(writtenCypher()).not.toContain('SET s.label')
  })

  it('iniziale e terminale nella STESSA chiamata → rifiutato', async () => {
    results = [
      { records: [makeRecord({ version: 3 })] },
      { records: [makeRecord({ terminal: false })] },
    ]
    await expect(M.saveWorkflowChanges(null, { ...base, steps: [step({ isInitial: true, isTerminal: true })] }, ctx))
      .rejects.toThrow(/it cannot also be the initial step/)
  })

  it('due passi marcati iniziali → rifiutato dicendo quali', async () => {
    results = [{ records: [makeRecord({ version: 3 })] }]
    await expect(M.saveWorkflowChanges(null, {
      ...base,
      steps: [step({ stepName: 'a', isInitial: true }), step({ stepName: 'b', isInitial: true })],
    }, ctx)).rejects.toThrow(/Only one step can be initial.*a, b/s)
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
    // B-27: la prima risposta è il controllo dei duplicati (nessuno).
    results = [
      { records: [] },
      { records: [makeRecord({ tr: { properties: { trigger: 'manual', label: 'x' } }, fromStep: 'a', toStep: 'b', entityType: 'incident' })] },
    ]
    await M.addWorkflowTransition(null, { definitionId: 'def-1', fromStepName: 'a', toStepName: 'b' }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')

    calls.length = 0
    results = [{ records: [makeRecord({ deletedId: 'tr-1', entityType: 'incident' })] }]
    await M.removeWorkflowTransition(null, { definitionId: 'def-1', transitionId: 'tr-1' }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')

    calls.length = 0
    // B-26: la SET restituisce l'id toccato — se non tocca niente, NOT_FOUND.
    results = [
      { records: [makeRecord({ id: 'tr-1' })] },
      { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'incident' } }, steps: [] })] },
    ]
    await M.updateWorkflowTransition(null, {
      definitionId: 'def-1', transitionId: 'tr-1',
      input: { requiresInput: false },
    }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
  })

  /**
   * Revisione totale · M-9: `coalesce($condition, t.condition)` non permetteva
   * di CANCELLARE una condizione: passare null lasciava quella vecchia, e una
   * condizione sbagliata su una transizione restava per sempre a bloccarla.
   * Ora conta se il campo è presente nell'input.
   */
  it('updateWorkflowTransition: null CANCELLA il campo presente, l\'assenza lo lascia (M-9)', async () => {
    const paramsOf = () => calls.find((c) => /SET t\.label/.test(c.cypher))!.params as Record<string, unknown>

    calls.length = 0
    results = [{ records: [makeRecord({ id: 'tr-1' })] }, { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'incident' } }, steps: [] })] }]
    await M.updateWorkflowTransition(null, { definitionId: 'def-1', transitionId: 'tr-1', input: { requiresInput: false, condition: null, timerHours: null } }, ctx)
    expect(paramsOf()).toMatchObject({ conditionGiven: true, condition: null, timerHoursGiven: true, timerHours: null })

    calls.length = 0
    results = [{ records: [makeRecord({ id: 'tr-1' })] }, { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'incident' } }, steps: [] })] }]
    await M.updateWorkflowTransition(null, { definitionId: 'def-1', transitionId: 'tr-1', input: { requiresInput: false } }, ctx)
    expect(paramsOf()).toMatchObject({ conditionGiven: false, timerHoursGiven: false, triggerGiven: false })

    // L'etichetta vuota NON cancella: un arco senza etichetta non si clicca.
    calls.length = 0
    results = [{ records: [makeRecord({ id: 'tr-1' })] }, { records: [makeRecord({ wd: { properties: { id: 'def-1', entity_type: 'incident' } }, steps: [] })] }]
    await M.updateWorkflowTransition(null, { definitionId: 'def-1', transitionId: 'tr-1', input: { requiresInput: false, label: null } }, ctx)
    expect(paramsOf()).toMatchObject({ labelGiven: false })
  })

  it('updateWorkflowStep marchia e invalida la cache', async () => {
    results = [{ records: [makeRecord({ s: { properties: { id: 's1', name: 'assigned', label: 'L', type: 'standard' } }, entityType: 'incident' })] }]
    await M.updateWorkflowStep(null, { definitionId: 'def-1', stepName: 'assigned', label: 'L' }, ctx)
    expect(writtenCypher()).toContain('wd.customized_at = $customizedAt')
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('c-two', 'incident')
  })

  /** Giro del 14 set 2026 (#22): un'etichetta cambiata è del cliente, le traduzioni spedite non valgono più. */
  it('updateWorkflowStep toglie le traduzioni solo se l\'etichetta CAMBIA', async () => {
    results = [{ records: [makeRecord({ s: { properties: { id: 's1', name: 'assigned', label: 'L', type: 'standard' } }, entityType: 'incident' })] }]
    await M.updateWorkflowStep(null, { definitionId: 'def-1', stepName: 'assigned', label: 'L' }, ctx)
    const cypher = writtenCypher()
    // Secondo giro UI · V-5: le traduzioni si mettono da parte al primo cambio e tornano con l'etichetta d'origine.
    expect(cypher).toContain('SET s.labels = CASE WHEN s.label = $label THEN s.labels WHEN s.labels_origin_label = $label THEN s.labels_origin ELSE null END')
    expect(cypher.indexOf('s.labels_origin_label = CASE WHEN s.label <> $label')).toBeLessThan(cypher.indexOf('SET s.labels = CASE'))
    expect(cypher.indexOf('SET s.labels = CASE')).toBeLessThan(cypher.indexOf('SET s.label        = $label'))
  })

  it('saveWorkflowLayout NON marchia: la posizione sul canvas non è configurazione di processo', async () => {
    await M.saveWorkflowLayout(null, { definitionId: 'def-1', positions: [{ stepId: 's1', positionX: 1, positionY: 2 }] }, ctx)
    expect(writtenCypher()).not.toContain('customized_at')
    expect(invalidateWorkflowCache).not.toHaveBeenCalled()
  })
})

// ── Revisione delle otto ondate · ondata di rimedio 2 ─────────────────────────

/**
 * B·N-3 — la **categoria** del passo era rimasta testo libero.
 *
 * L'ondata 4 ha dato allo *scopo* un vocabolario chiuso, una tendina e una
 * validazione in scrittura; la categoria è restata un `<Input list=…>` con una
 * `datalist` di suggerimenti — e nel frattempo l'ondata 8 le ha fatto decidere
 * «risolto» (che valorizza `resolved_at` e `root_cause`), la chiusura
 * automatica, l'escalation e le classi di stato. Dal vivo, nella revisione:
 * `category = 'risolto'` accettata, transizione riuscita, `resolved_at` NULL.
 */
describe('la categoria del passo è un vocabolario chiuso (B·N-3)', () => {
  const base = { definitionId: 'def-1', transitions: [], positions: [], expectedVersion: null }
  const step = (over: Record<string, unknown> = {}) => ({
    stepName: 'risolto', label: 'Risolto', enterActions: null, exitActions: null, ...over,
  })

  it('la parola italiana che l\'interfaccia invitava a scrivere ora è rifiutata, dicendo le ammesse', async () => {
    await expect(M.saveWorkflowChanges(null, { ...base, steps: [step({ category: 'risolto' })] }, ctx))
      .rejects.toThrow(/category "risolto" out of vocabulary.*active, waiting, escalated, resolved, closed, draft, published, failed/s)
    expect(calls).toHaveLength(0)   // rifiutata PRIMA di aprire la transazione
  })

  it('il rifiuto spiega che il nome per gli utenti è l\'etichetta, non la categoria', async () => {
    await expect(M.saveWorkflowChanges(null, { ...base, steps: [step({ category: 'chiuso' })] }, ctx))
      .rejects.toThrow(/the step label, not this one/)
  })

  it('una categoria del vocabolario passa e viene scritta', async () => {
    results = [{ records: [makeRecord({ version: 3 })] }]
    // Il mock minimo fa fallire la lettura finale che rimappa la definizione:
    // conta il Cypher scritto, come negli altri test di questo file.
    await M.saveWorkflowChanges(null, { ...base, steps: [step({ category: 'resolved' })] }, ctx).catch(() => null)
    expect(paramsOf('SET s.label')?.['steps']).toEqual([expect.objectContaining({ category: 'resolved' })])
  })

  it('categoria assente o vuota = non mandata: resta quella salvata (era già così)', async () => {
    results = [{ records: [makeRecord({ version: 3 })] }]
    await M.saveWorkflowChanges(null, { ...base, steps: [step({ category: '' })] }, ctx).catch(() => null)
    expect(paramsOf('SET s.label')?.['steps']).toEqual([expect.objectContaining({ category: null })])
    expect(writtenCypher()).toContain('s.category      = coalesce(st.category,   s.category)')
  })
})

/**
 * B·M-4 — innesco e condizione delle transizioni.
 *
 * Il registro delle condizioni è chiuso (sono funzioni nel codice): un refuso
 * si salvava senza un fiato e trasformava l'arco in un muro, perché il motore
 * risponde «Condizione di transizione sconosciuta» a ogni tentativo.
 */
describe('innesco e condizione delle transizioni sono vocabolari chiusi (B·M-4)', () => {
  const base = { definitionId: 'def-1', steps: null, positions: [], expectedVersion: null }
  const tr = (over: Record<string, unknown> = {}) => ({
    transitionId: 'tr-1', label: 'Avanti', trigger: 'manual', requiresInput: false,
    inputField: null, condition: null, timerHours: null, ...over,
  })

  it('il refuso della revisione è rifiutato, e il messaggio dice perché è grave', async () => {
    await expect(M.saveWorkflowChanges(null, { ...base, transitions: [tr({ condition: 'all_assessment_complete' })] }, ctx))
      .rejects.toThrow(/condition "all_assessment_complete" unknown.*blocks the edge/s)
    expect(calls).toHaveLength(0)
  })

  it('un innesco inventato è rifiutato (l\'arco non verrebbe percorso da nessuno)', async () => {
    await expect(M.saveWorkflowChanges(null, { ...base, transitions: [tr({ trigger: 'quando_mi_pare' })] }, ctx))
      .rejects.toThrow(/trigger "quando_mi_pare" out of vocabulary.*manual, automatic, timer, sla_breach/s)
  })

  it('una condizione del registro passa; il vuoto la TOGLIE (è il modo di sbloccare un arco)', async () => {
    results = [{ records: [makeRecord({ version: 3 })] }]
    await M.saveWorkflowChanges(null, {
      ...base,
      transitions: [tr({ condition: 'all_assessments_complete' }), tr({ transitionId: 'tr-2', condition: '' })],
    }, ctx).catch(() => null)
    const written = paramsOf('SET t.label')?.['transitions'] as Array<Record<string, unknown>>
    expect(written[0]!['condition']).toBe('all_assessments_complete')
    expect(written[1]!['condition']).toBeNull()
  })

  it('addWorkflowTransition valida l\'innesco alla creazione dell\'arco', async () => {
    await expect(M.addWorkflowTransition(null, {
      definitionId: 'def-1', fromStepName: 'a', toStepName: 'b', trigger: 'timer_scaduto',
    }, ctx)).rejects.toThrow(/trigger "timer_scaduto" out of vocabulary/)
  })
})

/**
 * B·N-1 — il workflow delle change deve conservare un posto dove approvare.
 *
 * Il varco delle approvazioni è un `if` sullo scopo del passo, con il controllo
 * dei requisiti e `requireRole('admin')` dentro il ramo: togliere lo scopo dalla
 * tendina — due clic — li faceva cadere insieme al ramo. La difesa che conta è
 * sul passo di ARRIVO (vedi `changeApprovalWindowGate.test.ts`); questa impedisce
 * di **entrare** nello stato, che è sempre meglio che accorgersene dopo.
 */
describe('gli scopi che il workflow delle change non puo perdere (B·N-1 + terza revisione · G2)', () => {
  const base = { definitionId: 'def-1', transitions: [], positions: [], expectedVersion: null }
  const step = (over: Record<string, unknown> = {}) => ({
    stepName: 'cab', label: 'CAB', enterActions: null, exitActions: null, purpose: '', ...over,
  })

  /**
   * L'ordine delle query quando si tocca uno scopo: versione, conteggio dei
   * passi di finestra PRIMA, scrittura dei passi, guardia dell'approvazione,
   * conteggio dei passi di finestra DOPO.
   */
  const coda = (opts: { approvalSteps?: number | null; windowBefore?: number; windowAfter?: number }) => [
    { records: [makeRecord({ version: 3 })] },
    { records: [makeRecord({ n: opts.windowBefore ?? 1 })] },
    { records: [] },
    opts.approvalSteps == null ? { records: [] } : { records: [makeRecord({ approvalSteps: opts.approvalSteps })] },
    { records: [makeRecord({ n: opts.windowAfter ?? 1 })] },
    // La rilettura finale della definizione: senza, la mutation muore con un
    // NOT_FOUND che non c'entra con le guardie.
    { records: [makeRecord({ version: 4, id: 'def-1', entityType: 'change', name: 'Change', steps: [], transitions: [] })] },
  ]

  /** Esegue e restituisce l'errore, o `null` se e andata. Niente `String(err)`. */
  const esegui = (steps: ReturnType<typeof step>[]) =>
    M.saveWorkflowChanges(null, { ...base, steps }, ctx).then(() => null, (e: Error) => e)

  /**
   * «Le guardie hanno girato e hanno lasciato passare.»
   *
   * Non si assertisce che la mutation arrivi in fondo: con una coda di risposte
   * finta muore piu tardi per motivi suoi, e allungare la coda a indovinare e
   * fragile. Ma non si assertisce nemmeno `String(err).not.toMatch(...)` come
   * prima — quella passa anche con `String(null)` e con qualunque altro
   * errore. Si prova che la guardia e stata ESEGUITA, e che non e lei ad aver
   * fermato la mutation.
   */
  const expectVarchiAperti = (err: Error | null): void => {
    expect(writtenCypher(), 'la guardia dell\'approvazione non ha nemmeno girato').toContain("WHERE wd.entity_type = 'change'")
    if (err) {
      expect(err.message).not.toMatch(/scopo «Approvazione»/)
      expect(err.message).not.toMatch(/release-window purpose/)
    }
  }

  beforeEach(() => { preApprovedTypes = ['standard']; changeTypes = ['standard', 'normal', 'emergency'] })

  it('togliere l\'ultimo passo di approvazione e rifiutato, nominando i tipi che resterebbero scoperti', async () => {
    results = coda({ approvalSteps: 0 })
    const err = await esegui([step()])
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/no step would have the «Approval» purpose/)
    expect(err!.message).toMatch(/"normal", "emergency"/)
  })

  /**
   * IL DIFETTO G2. `normalizeStepPurpose` restituisce `null` solo per la
   * stringa vuota, e la guardia partiva solo su `null`: scegliere «Revisione»
   * invece di «nessuno» nella tendina SOSTITUIVA lo scopo e il workflow
   * restava senza nessun passo di approvazione. Due clic, gli stessi due clic
   * della revisione precedente. E il test che c'era pinnava la lacuna come
   * comportamento voluto.
   */
  it('SOSTITUIRE lo scopo dell\'ultimo passo di approvazione e rifiutato come toglierlo', async () => {
    results = coda({ approvalSteps: 0 })
    const err = await esegui([step({ purpose: 'review' })])
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/no step would have the «Approval» purpose/)
  })

  it('se un altro passo conserva lo scopo, si puo togliere — e la mutation RIESCE', async () => {
    results = coda({ approvalSteps: 1 })
    expectVarchiAperti(await esegui([step()]))
  })

  it('se il cliente ha pre-approvato TUTTI i suoi tipi, non c\'e niente da approvare', async () => {
    preApprovedTypes = ['standard', 'normal', 'emergency']
    results = coda({ approvalSteps: 0 })
    expectVarchiAperti(await esegui([step()]))
  })

  it('su un workflow che non e delle change nessuna delle due guardie si applica', async () => {
    // Entrambe le letture non trovano la definizione: non e `change`.
    results = [
      { records: [makeRecord({ version: 3 })] },
      { records: [] },
      { records: [] },
      { records: [] },
      { records: [] },
      { records: [makeRecord({ version: 4, id: 'def-1', entityType: 'incident', name: 'Incident', steps: [], transitions: [] })] },
    ]
    expectVarchiAperti(await esegui([step()]))
  })

  /**
   * Giro UI del 15 set 2026 · U-18. Il test qui sopra finge che una
   * definizione non-change dia «nessuna riga», ma in Neo4j `RETURN count(s)`
   * senza chiave di raggruppamento restituisce SEMPRE una riga (0): la guardia
   * dell'approvazione rifiutava ogni salvataggio di passo nel workflow degli
   * incident. Visto dal vivo nel disegnatore e con cypher-shell. Le due letture
   * devono raggruppare per la definizione, così «nessuna riga» è vero.
   */
  it('U-18: le due letture raggruppano per la definizione (un count da solo dà sempre una riga)', async () => {
    results = coda({ approvalSteps: 1 })
    await esegui([step()])
    const cypher = writtenCypher()
    expect(cypher).toContain('RETURN wd.id AS definitionId, count(s) AS approvalSteps')
    expect(cypher).toContain('RETURN wd.id AS definitionId, count(s) AS n')
    expect(cypher).not.toMatch(/RETURN count\(s\) AS (approvalSteps|n)\b/)
  })

  /**
   * Terza revisione · G2, seconda metà: su `scheduled` e `implementation` e
   * indicizzato il varco dal lato del passo di ARRIVO. Togliendo lo scopo,
   * `entersWindow` da sempre `false` e il varco si spegne — e con lui la
   * soppressione degli allarmi in finestra. Non c'era nessuna guardia.
   */
  it('togliere l\'ULTIMO passo della finestra di rilascio e rifiutato', async () => {
    results = coda({ approvalSteps: 1, windowBefore: 1, windowAfter: 0 })
    const err = await esegui([step({ stepName: 'scheduled', purpose: '' })])
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/release-window purpose/)
    expect(err!.message).toMatch(/scheduled, implementation/)
    // Il messaggio dice cosa fare, non solo cosa e vietato.
    expect(err!.message).toMatch(/Give the «Scheduled» or «Implementation» purpose/)
  })

  it('ma un workflow che non ne aveva nessuno non viene bloccato', async () => {
    // `before === 0`: non si sta togliendo l'ultimo, non ce n'erano.
    results = coda({ approvalSteps: 1, windowBefore: 0, windowAfter: 0 })
    expectVarchiAperti(await esegui([step()]))
  })

  it('e se non si tocca nessuno scopo, nessuna delle due guardie legge niente', async () => {
    results = [{ records: [makeRecord({ version: 3 })] }]
    await M.saveWorkflowChanges(null, { ...base, steps: [step({ purpose: undefined })] }, ctx).catch(() => null)
    expect(writtenCypher()).not.toContain("WHERE wd.entity_type = 'change'")
  })
})

/**
 * B·M-1 — il nome di un passo diventa lo `status` del ticket.
 *
 * Dall'interfaccia si poteva aggiungere solo un passo TECNICO (fork, join,
 * timer, sub-workflow), e per le change nemmeno quello: il passo di processo —
 * quello di cui tutte e otto le ondate parlano, «un CAB fra approvazione e
 * programmazione» — si poteva aggiungere solo con la mutation a mano. Adesso
 * il disegnatore lo offre, e il nome è lo slug dell'etichetta: quindi il nome
 * va validato, perché finisce nei filtri e nei report.
 */
describe('il nome del passo ha una forma (B·M-1)', () => {
  it('un nome con spazi o maiuscole è rifiutato, dicendo che l\'etichetta è libera', async () => {
    await expect(M.addWorkflowStep(null, {
      definitionId: 'def-1', name: 'CAB Settimanale', label: 'CAB settimanale', type: 'standard',
    }, ctx)).rejects.toThrow(/lowercase, digits and underscores.*the name people see is the label/s)
    expect(calls).toHaveLength(0)
  })

  it('un nome che inizia per cifra è rifiutato', async () => {
    await expect(M.addWorkflowStep(null, {
      definitionId: 'def-1', name: '2_livello', label: 'Secondo livello', type: 'standard',
    }, ctx)).rejects.toThrow(/must start with a letter/)
  })

  it('uno slug valido passa, e il passo nasce «in lavorazione» e senza scopo', async () => {
    results = [{ records: [makeRecord({ entityType: 'change' })] }]
    await M.addWorkflowStep(null, {
      definitionId: 'def-1', name: 'cab_settimanale', label: 'CAB settimanale', type: 'standard',
    }, ctx).catch(() => null)
    const p = paramsOf('CREATE (s:WorkflowStep')!
    expect(p).toMatchObject({ name: 'cab_settimanale', label: 'CAB settimanale', type: 'standard', category: 'active' })
    expect(writtenCypher()).toMatch(/is_open:\s+true/)
  })
})
