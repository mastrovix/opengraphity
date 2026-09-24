/**
 * requestService.createRequest / mapRequest — Neo4j,
 * workflow ed eventi mockati. Pinna: numero REQ + 8 cifre dal contatore
 * atomico (kind "service_request"), stato = step iniziale del workflow,
 * istanza di workflow, REQUESTED_BY, evento request.created con tenant/attore,
 * chiusura tramite transizione dell'engine (mai r.status a mano).
 *
 * La verifica del catalogo (item inesistente / non del tenant → NotFoundError,
 * campi obbligatori → VALIDATION_ERROR) vive nel resolver createServiceRequest:
 * vedi graphql/resolvers/__tests__/serviceRequestCreate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  /*
   * La TRANSAZIONE finta. Dal 17 set 2026 `createRequest` scrive tutto dentro
   * `session.executeWrite`: o c'è tutto o non c'è niente. Quindi la finta deve
   * ESEGUIRE il callback — altrimenti un test che crede di creare una
   * richiesta non esegue nemmeno la CREATE — e `tx.run` risponde come il
   * contatore dei numeri, che è l'unico a usarla direttamente (tutto il resto
   * passa da `runQuery`, mockata a parte).
   */
  const tx = { run: vi.fn(async () => ({ records: [{ get: () => 5 }] })) }
  return {
    tx,
    // `executeRead` esegue davvero il callback: `initialStepSelection` (mockata)
    // viene richiamata al suo interno.
    session: {
      executeRead: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      executeWrite: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      close: vi.fn(),
    },
  }
})

// I testi che il prodotto scrive nei ticket si risolvono nella lingua del cliente (lib/systemText.ts).
// Ondata 6 di «Nulla cablato»: il formato dei numeri è del cliente; qui quello di fabbrica.
vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
// Le esclusioni CI: il doppio non esclude niente e REGISTRA le chiamate, che è
// quello che il test dell'ondata 9 pretende.
vi.mock('../../lib/ticketCIExclusions.js', () => import('../../lib/__tests__/ticketCIExclusionsFake.js'))
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  toNumber:    (v: unknown) => (typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), registerCondition: vi.fn() },
  /**
   * Moduli del catalogo, ondata 3: il passo iniziale viene dalla STESSA
   * selezione che usa l'istanza, con l'iter della voce di catalogo se c'è.
   * Prima `requestService` faceva una lettura sua (`getInitialStepName`) che
   * guardava tutte le definizioni del tipo: con una definizione per voce il
   * ticket sarebbe nato con lo stato di un iter e l'istanza su un altro.
   */
  initialStepSelection: vi.fn(async () => ({
    definitionId: 'def-sr', stepId: 'step-1', stepName: 'submitted', definitionCategory: null,
  })),
}))
vi.mock('../../lib/db.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)),
  getSession:  vi.fn(),
}))
// The creation's event is recorded in its transaction and published after (wave 7 · B2).
vi.mock('../../lib/publishEvent.js', () => import('../../lib/__tests__/publishEventFake.js'))
vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('submitted'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

const { createRequest, mapRequest } = await import('../requestService.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }
// Il doppio delle esclusioni, per pretendere che il controllo ci sia (ondata 9).
const esclusioniFinte = await import('../../lib/__tests__/ticketCIExclusionsFake.js')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Call = [string, Record<string, unknown>]
const queriesWith = (needle: string): Call[] =>
  vi.mocked(runQuery).mock.calls
    .map(c => [c[1] as string, c[2] as Record<string, unknown>] as Call)
    .filter(([cypher]) => cypher.includes(needle))

const STEPS = [
  { name: 'submitted', isInitial: true,  isTerminal: false, isOpen: true,  category: null,     stepOrder: 1 },
  { name: 'fulfilled', isInitial: false, isTerminal: true,  isOpen: false, category: 'closed', stepOrder: 2 },
]

/**
 * I tetti dei moduli (ondata 4/7): `createRequest` li legge per sapere quante
 * righe accetta una tabella. Qui non interessano — interessa la revisione —
 * quindi la finta risponde con i valori di fabbrica.
 */
vi.mock('../../lib/catalogFormLimits.js', () => ({
  catalogFormLimits: vi.fn(async () => ({ maxLibraryFields: 120, maxFieldsPerForm: 60, maxTableRows: 50 })),
}))

/**
 * Cosa risponde la query della voce di catalogo. Vuoto = la voce non ha un
 * modulo, che è il caso di tutti i test tranne quelli sulla revisione.
 */
let moduloDellaVoce: Array<{ form: string | null; name: string }> = []

beforeEach(() => {
  vi.clearAllMocks()
  moduloDellaVoce = []
  h.tx.run.mockResolvedValue({ records: [{ get: () => 5 }] })
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('CREATE (r:ServiceRequest')) {
      return [{ props: {
        id: params?.['id'], tenant_id: params?.['tenantId'], number: params?.['number'], title: params?.['title'],
        description: params?.['description'], status: params?.['status'], priority: params?.['priority'], due_date: params?.['dueDate'],
        catalog_item_id: params?.['catalogItemId'], requires_approval: params?.['requiresApproval'],
        created_at: params?.['now'], updated_at: params?.['now'],
      } }]
    }
    // Il modulo della voce di catalogo: `moduloDellaVoce` lo decide caso per
    // caso (ondata 8, la revisione cambiata sotto chi compila).
    if (cypher.includes('RETURN i.form AS form')) return moduloDellaVoce
    if (cypher.includes('HAS_WORKFLOW')) return [{ instanceId: 'wi-sr', step: 'submitted' }]
    if (cypher.includes('SET r.completed_at')) return [{ props: { id: params?.['id'], number: 'REQ00000005', title: 'T', status: 'fulfilled', priority: 'medium', completed_at: params?.['now'] } }]
    return []
  })
  vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-sr' } as never)
  vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
  vi.mocked(getWorkflowSteps).mockResolvedValue(STEPS)
})

// ── createRequest ─────────────────────────────────────────────────────────────

describe('createRequest', () => {
  // Wave 7 · B2: `request.created` exists if and only if the request does.
  it('request.created is written to the outbox in the creation\'s transaction, and that event is published', async () => {
    const { recordDomainEventIn, publishDomainEvent } = await import('../../lib/__tests__/publishEventFake.js')
    await createRequest({ title: 'Nuovo laptop', priority: 'medium' }, ctx)
    const tx = vi.mocked(workflowEngine.createInstance).mock.calls[0]![0]
    expect(recordDomainEventIn).toHaveBeenCalledWith(tx, expect.objectContaining({ type: 'request.created', tenant_id: 'tenant-1' }))
    expect(publishDomainEvent).toHaveBeenCalledWith(vi.mocked(recordDomainEventIn).mock.calls[0]![1])
  })

  it('numero REQ + 8 cifre dal contatore atomico (kind "service_request", tenant corrente)', async () => {
    await createRequest({ title: 'Nuovo laptop', priority: 'medium' }, ctx)
    // Il contatore passa da `tx.run`; tutto il resto della creazione da `runQuery`.
    expect(h.tx.run.mock.calls[0]![0]).toMatch(/MERGE \(c:Counter \{tenant_id: \$tenantId, kind: \$kind\}\)/)
    expect(h.tx.run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1', kind: 'service_request' })

    const [[, params]] = queriesWith('CREATE (r:ServiceRequest')
    expect(params['number']).toBe('REQ00000005')
    expect(params['number']).toMatch(/^REQ\d{8}$/)
  })

  it('stato iniziale = primo step del workflow service_request (nessun "open" fantasma)', async () => {
    const created = await createRequest({ title: 'T', priority: 'low' }, ctx)
    const [[, params]] = queriesWith('CREATE (r:ServiceRequest')
    expect(params['status']).toBe('submitted')
    expect(created.status).toBe('submitted')
  })

  it('scrive tutti i campi (catalogo, approvazione, scadenza) con default espliciti e restituisce il mapping unico', async () => {
    const created = await createRequest(
      { title: 'VPN', description: 'accesso', priority: 'high', dueDate: '2026-10-01', catalogItemId: 'cat-1', requiresApproval: true }, ctx)
    const [[, params]] = queriesWith('CREATE (r:ServiceRequest')
    expect(params).toMatchObject({
      tenantId: 'tenant-1', title: 'VPN', description: 'accesso', priority: 'high', dueDate: '2026-10-01',
      catalogItemId: 'cat-1', requiresApproval: true,
    })
    expect(params['id']).toMatch(UUID_RE)
    expect(created).toMatchObject({
      id: params['id'], number: 'REQ00000005', tenantId: 'tenant-1', title: 'VPN', description: 'accesso', status: 'submitted',
      priority: 'high', dueDate: '2026-10-01', catalogItemId: 'cat-1', requiresApproval: true, requestedBy: null, assignee: null,
    })

    vi.clearAllMocks()
    const bare = await createRequest({ title: 'T', priority: 'low' }, ctx)
    const [[, p2]] = queriesWith('CREATE (r:ServiceRequest')
    expect(p2).toMatchObject({ description: null, dueDate: null, catalogItemId: null, requiresApproval: false })
    expect(bare).toMatchObject({ catalogItemId: null, requiresApproval: false })
  })

  it('acknowledgeNoSla → registra quando e chi ha accettato di crearla senza SLA; senza, nulla', async () => {
    await createRequest({ title: 'VPN', priority: 'low', acknowledgeNoSla: true }, ctx)
    const [[cypher, params]] = queriesWith('CREATE (r:ServiceRequest')
    expect(cypher).toContain('sla_absence_acknowledged_at: $ackAt')
    expect(params['ackAt']).toBe(params['now'])
    expect(params['ackBy']).toBe('user-1')

    vi.clearAllMocks()
    await createRequest({ title: 'VPN', priority: 'low' }, ctx)
    const [[, p2]] = queriesWith('CREATE (r:ServiceRequest')
    expect(p2).toMatchObject({ ackAt: null, ackBy: null })
  })

  it('collega il richiedente con REQUESTED_BY (tenant-scoped) e crea l\'istanza di workflow service_request', async () => {
    await createRequest({ title: 'T', priority: 'low' }, ctx)
    const [[cypher, params]] = queriesWith('MERGE (r)-[:REQUESTED_BY]->(u)')
    // The requester is whoever opens it, when it is not opened for someone else (G28).
    expect(cypher).toContain('OPTIONAL MATCH (u:User {id: $requesterId, tenant_id: $tenantId})')
    expect(params).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', requesterId: 'user-1' })
    expect(workflowEngine.createInstance).toHaveBeenCalledTimes(1)
    /**
     * Moduli del catalogo, ondata 3: l'istanza nasce sull'ITER della voce di
     * catalogo se c'è (`definitionId`) e sulla categoria altrimenti. Senza
     * voce sono entrambi assenti, ed è la scelta per tipo di sempre.
     */
    // L'istanza si crea nella TRANSAZIONE della creazione, non nella sessione:
    // dal 17 set 2026 o c'è tutto o non c'è niente (prima una richiesta poteva
    // restare senza iter).
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(
      h.tx, 'tenant-1', expect.stringMatching(UUID_RE), 'service_request', undefined, null,
    )
  })

  it('opened for a colleague (G28): the colleague is the requester, both follow it; an unknown person stops the creation', async () => {
    const base = vi.mocked(runQuery).getMockImplementation()!
    vi.mocked(runQuery).mockImplementation(async (sess: unknown, cypher: string, params?: Record<string, unknown>) =>
      (cypher.includes('WHERE coalesce(u.active, true) RETURN u.id AS id') ? (params?.['requesterId'] === 'u-colleague' ? [{ id: 'u-colleague' }] : []) : base(sess as never, cypher, params)))
    await createRequest({ title: 'T', priority: 'low', requestedForId: 'u-colleague' }, ctx)
    const [[cypher, params]] = queriesWith('MERGE (r)-[:REQUESTED_BY]->(u)')
    expect(params).toMatchObject({ requesterId: 'u-colleague', userId: 'user-1' })
    expect(cypher).toContain('MERGE (me)-[w:WATCHES]->(r)')
    await expect(createRequest({ title: 'T', priority: 'low', requestedForId: 'u-ghost' }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.serviceRequest.requestedForUnknown' } } })
  })

  it('pubblica request.created con tenant, attore e payload minimo', async () => {
    await createRequest({ title: 'T', priority: 'high' }, ctx)
    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledWith('request.created', 'tenant-1', 'user-1',
      { id: expect.stringMatching(UUID_RE), title: 'T', priority: 'high' }, expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
  })

  it('CREATE senza riga → errore esplicito; niente workflow né evento', async () => {
    vi.mocked(runQuery).mockResolvedValue([])
    await expect(createRequest({ title: 'T', priority: 'low' }, ctx)).rejects.toThrow('Failed to create service request')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

// ── mapRequest ────────────────────────────────────────────────────────────────

describe('mapRequest', () => {
  it('espone catalogItemId/requiresApproval (la copia del resolver li perdeva) con default null/false', () => {
    expect(mapRequest({ id: 'r', tenant_id: 't', title: 'T', status: 's', priority: 'p', created_at: 'c', updated_at: 'u' }))
      .toEqual({ id: 'r', number: '', tenantId: 't', title: 'T', description: undefined, status: 's', priority: 'p', dueDate: undefined,
        completedAt: undefined, catalogItemId: null, category: null, requiresApproval: false,
        // Moduli del catalogo (ondata 1): null quando la richiesta non nasce da un modulo.
        formRevision: null,
        createdAt: 'c', updatedAt: 'u', requestedBy: null, assignee: null })
    expect(mapRequest({ catalog_item_id: 'cat', requires_approval: true, number: 'REQ00000001' }))
      .toMatchObject({ catalogItemId: 'cat', requiresApproval: true, number: 'REQ00000001' })
  })
})

/**
 * IL MODULO CAMBIATO MENTRE SI COMPILAVA (ondata 8, regola chiesta dal
 * proprietario).
 *
 * Prima, le risposte scritte sulla revisione 5 venivano validate sulla 8: chi
 * compilava riceveva «il campo X non è di questo modulo» oppure «campo
 * obbligatorio» su una domanda che non aveva mai visto. Due rifiuti veri per un
 * motivo incomprensibile. Ora si dice la cosa giusta e si ricomincia.
 */
describe('createRequest e la revisione del modulo', () => {
  const modulo = (revision: number) => JSON.stringify({
    version: 1, revision,
    // Il titolo di una sezione è un testo PER LINGUA (`{it: …}`), non una lista.
    sections: [{ id: 's1', title: { it: 'Sezione' }, items: [] }],
  })

  it('revisione compilata diversa da quella di adesso: si rifiuta dicendolo', async () => {
    moduloDellaVoce = [{ form: modulo(8), name: 'Nuovo portatile' }]
    await expect(createRequest(
      { title: 'T', priority: 'medium', catalogItemId: 'cat-1', formRevision: 5 }, ctx,
    )).rejects.toThrow(/changed while you were filling it \(revision 5 → 8\)/)
  })

  it('stessa revisione: si procede', async () => {
    moduloDellaVoce = [{ form: modulo(8), name: 'Nuovo portatile' }]
    const r = await createRequest(
      { title: 'T', priority: 'medium', catalogItemId: 'cat-1', formRevision: 8 }, ctx,
    )
    expect(r.id).toMatch(UUID_RE)
  })

  it('un client che NON manda la revisione si accetta come prima: non si inventa un rifiuto', async () => {
    moduloDellaVoce = [{ form: modulo(8), name: 'Nuovo portatile' }]
    const r = await createRequest(
      { title: 'T', priority: 'medium', catalogItemId: 'cat-1' }, ctx,
    )
    expect(r.id).toMatch(UUID_RE)
  })
})


/**
 * TUTTO QUELLO CHE SCRIVE STA IN UNA TRANSAZIONE (revisione del 17 set 2026).
 *
 * `withSession(fn, true)` apre una sessione, non una transazione: ogni query
 * faceva storia a sé, e il commento nel codice — «un fallimento fa fallire la
 * creazione invece di lasciare un ticket a metà» — era falso. Un errore alla
 * dodicesima riga di tabella lasciava undici righe, i riferimenti scritti e
 * gli allegati reclamati; un errore sull'istanza lasciava una richiesta senza
 * iter.
 */
describe('createRequest: atomicità', () => {
  it('la CREATE, il richiedente e l\'istanza passano dalla stessa transazione', async () => {
    await createRequest({ title: 'T', priority: 'medium' }, ctx)
    // Una sola apertura di transazione per la creazione (più quella del contatore).
    expect(h.session.executeWrite).toHaveBeenCalled()
    // E le scritture hanno ricevuto la transazione, non la sessione.
    for (const [primo, cypher] of vi.mocked(runQuery).mock.calls.map((c) => [c[0], c[1]] as const)) {
      if (typeof cypher === 'string' && (cypher.includes('CREATE (r:ServiceRequest') || cypher.includes('REQUESTED_BY'))) {
        expect(primo).toBe(h.tx)
      }
    }
  })

  it('se l\'istanza di workflow non si crea, la creazione FALLISCE (niente ticket senza iter)', async () => {
    vi.mocked(workflowEngine.createInstance).mockRejectedValueOnce(new Error('nessuna definizione attiva'))
    await expect(createRequest({ title: 'T', priority: 'medium' }, ctx)).rejects.toThrow(/nessuna definizione attiva/)
  })
})


/**
 * UN CAMPO «RIFERIMENTO ALLA CMDB» È UNA STRADA PER COLLEGARE UN CI (ondata 9).
 *
 * `lib/ticketCIExclusions.ts` promette che un CI di un tipo escluso non si
 * collega al ticket «da nessuna strada». I campi `ref_ci` dei moduli sono nati
 * dopo quella promessa e scrivevano `FORM_REFERS_TO_CI` senza chiedere niente:
 * bastava mettere un riferimento nel modulo per rimettere nel ticket un tipo
 * che l'amministratore aveva escluso, e da lì tornava in filtri e report.
 */
describe('createRequest e le esclusioni dei tipi di CI', () => {
  const moduloConRiferimento = JSON.stringify({
    version: 1, revision: 1,
    sections: [{ id: 's1', title: { it: 'Sezione' }, items: [{ field: 'server_interessato', required: false }] }],
  })

  function libreriaConRefCi() {
    const precedente = vi.mocked(runQuery).getMockImplementation()!
    vi.mocked(runQuery).mockImplementation(async (s: unknown, cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (f:FormField')) {
        return [{
          id: 'f1', name: 'server_interessato', fieldType: 'ref_ci', label: 'Server', labels: null,
          help: null, helps: null, required: false, vocabulary: null, validationScript: null, formula: null,
          tableDefinition: null, inList: false, refTypes: null, shared: false, refFilter: null,
          createdAt: null, updatedAt: null,
        }]
      }
      // Il CI esiste: `assertRiferimentoEsiste` lo cerca per id.
      if (cypher.includes('MATCH (n:ConfigurationItem')) return [{ id: 'ci-1' }]
      return precedente(s, cypher, params)
    })
  }

  it('i CI puntati dai campi di riferimento passano dal controllo delle esclusioni', async () => {
    moduloDellaVoce = [{ form: moduloConRiferimento, name: 'Accesso al server' }]
    libreriaConRefCi()
    await createRequest({
      title: 'T', priority: 'medium', catalogItemId: 'cat-1', formRevision: 1,
      formAnswers: [{ name: 'server_interessato', refIds: ['ci-1'] }],
    }, ctx)
    expect(esclusioniFinte.assertCIsLinkable).toHaveBeenCalledWith(ctx.tenantId, 'service_request', ['ci-1'])
  })

  it('un CI di tipo escluso ferma la creazione: niente ticket a metà', async () => {
    moduloDellaVoce = [{ form: moduloConRiferimento, name: 'Accesso al server' }]
    libreriaConRefCi()
    esclusioniFinte.assertCIsLinkable.mockRejectedValueOnce(new Error('These CIs cannot be linked to this service_request'))
    await expect(createRequest({
      title: 'T', priority: 'medium', catalogItemId: 'cat-1', formRevision: 1,
      formAnswers: [{ name: 'server_interessato', refIds: ['ci-1'] }],
    }, ctx)).rejects.toThrow(/cannot be linked/)
    // Il controllo sta PRIMA della transazione: nessuna CREATE è partita.
    expect(vi.mocked(runQuery).mock.calls.some((c) => String(c[1]).includes('CREATE (r:ServiceRequest'))).toBe(false)
  })
})
