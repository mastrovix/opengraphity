import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
// Le note si compongono nella lingua del cliente: qui italiano, come le attese.
// Ondata 6 di «Nulla cablato»: il formato dei numeri è del cliente; qui quello di fabbrica.
vi.mock('../../lib/ticketCIExclusions.js', () => import('../../lib/__tests__/ticketCIExclusionsFake.js'))
vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [{ get: () => 1 }] }),  // atomic counter returns a value
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/events', () => ({
  publish:         vi.fn().mockResolvedValue(undefined),
  getRedisOptions: vi.fn(() => ({})),
}))

vi.mock('../../lib/triggerEngine.js', () => ({
  evaluateTriggers:      vi.fn().mockResolvedValue(undefined),
  scheduleTimerTriggers: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
    registerCondition: vi.fn(),
  },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  // Stub of the real helper (D-22): plain numbers and Integer-like objects.
  toNumber:    (v: unknown) => (v == null ? 0 : typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))

vi.mock('../../lib/rulesEngine.js', () => ({
  evaluateBusinessRules: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('new'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([
    { name: 'new',       isInitial: true,  isTerminal: false, isOpen: true,  category: null },
    { name: 'escalated', isInitial: false, isTerminal: false, isOpen: true,  category: 'escalated' },
    { name: 'resolved',  isInitial: false, isTerminal: true,  isOpen: false, category: 'resolved' },
  ]),
}))

vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  getSession: vi.fn(),
}))

vi.mock('../../lib/mappers.js', () => ({
  mapIncident: vi.fn((props: Record<string, unknown>) => ({
    id:       props['id'],
    title:    props['title'],
    severity: props['severity'],
    status:   props['status'],
  })),
}))

vi.mock('../../lib/stepEnteredPublisher.js', () => ({ publishStepEnteredForEntity: vi.fn() }))

// ── Import after mocks ────────────────────────────────────────────────────────

const { createIncident, resolveIncident, escalateIncident, publishIncidentTransition } = await import('../incidentService.js')
const { publish } = await import('@opengraphity/events')
const { publishStepEnteredForEntity } = await import('../../lib/stepEnteredPublisher.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')

// ── Test context ──────────────────────────────────────────────────────────────

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }

/**
 * `runQuery` per cypher: la CREATE dell'incident ritorna le props, il MERGE dei
 * CI impattati ritorna `linked` (il conteggio che `createIncident` legge, C-2).
 */
function primeIncidentRow(props: Record<string, unknown>, linked = 1): void {
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string) =>
    cypher.includes('MERGE (i)-[r:AFFECTED_BY]->(ci)')
      ? ([{ linked }] as never)
      : ([{ props }] as never))
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('createIncident', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // runQuery must return an array with a row that mapIncident can use.
    // Ondata 6 (C-2): il MERGE verso i CI impattati ritorna il conteggio dei
    // collegamenti e `createIncident` lo LEGGE — prima nessuno lo guardava e un
    // incident poteva nascere senza CI, in silenzio.
    primeIncidentRow({ id: 'inc-1', title: 'Test incident', severity: 'high', status: 'open' })
    // incident-number progressive count
    vi.mocked(runQueryOne).mockResolvedValue({ cnt: 0 })
    // Revisione totale · B-7: `incident.created` rilegge il payload dal grafo
    // (prima ciName e assignedTo erano «—» scritti a mano).
    const payloadRow = { get: (k: string) => (({ id: 'inc-1', title: 'Test incident', severity: 'high', status: 'open', ciName: 'srv-1', assignedTo: 'Mario' }) as Record<string, string>)[k] }
    mockSession.executeRead.mockResolvedValue({ records: [payloadRow] })
  })

  it('rifiuta la creazione senza CI impattato', async () => {
    await expect(
      createIncident({ title: 'Senza CI', severity: 'high' }, ctx),
    ).rejects.toThrow(/at least one impacted CI/)
    await expect(
      createIncident({ title: 'CI vuoto', severity: 'high', affectedCIIds: [] }, ctx),
    ).rejects.toThrow(/at least one impacted CI/)
    expect(publish).not.toHaveBeenCalled()
  })

  // ── C-2 (CRITICO) ─────────────────────────────────────────────────────────
  // Il MERGE verso i CI impattati girava sotto il predicato con le etichette
  // FISSE e nessuno leggeva il risultato: zero righe = incident senza
  // AFFECTED_BY, senza errore e senza log, in contraddizione con la guardia
  // «at least one impacted CI impattato» tre righe sopra.
  it('il collegamento ai CI usa il predicato del TENANT e ne conta le righe', async () => {
    await createIncident({ title: 'Test incident', severity: 'high', affectedCIIds: ['ci-1'] }, ctx)
    const merge = vi.mocked(runQuery).mock.calls
      .map(c => c[1] as string)
      .find(c => c.includes('MERGE (i)-[r:AFFECTED_BY]->(ci)'))
    expect(merge, 'nessun MERGE AFFECTED_BY eseguito').toBeDefined()
    expect(merge).toContain('ci:LoadBalancer')          // tipo del cliente, non più escluso
    expect(merge).toContain('RETURN count(r) AS linked') // il risultato si legge
  })

  it('CI impattato non collegabile → errore, incident ANNULLATO, nessun evento né workflow', async () => {
    // Il CI non è un CI di questo cliente (o è sparito): il MERGE scrive zero righe.
    primeIncidentRow({ id: 'inc-1', title: 'Test incident', severity: 'high', status: 'open' }, 0)

    await expect(
      createIncident({ title: 'Test incident', severity: 'high', affectedCIIds: ['ci-ignoto'] }, ctx),
    ).rejects.toThrow(/Incident not created: 1 of the 1 impacted CIs.*ci-ignoto/)

    // L'incident committato in transazione propria viene rimosso: non resta in
    // banca dati un incident senza CI (e senza istanza di workflow).
    const cleanup = vi.mocked(runQuery).mock.calls
      .map(c => c[1] as string)
      .find(c => c.includes('DETACH DELETE i'))
    expect(cleanup, 'l\'incident non è stato annullato').toBeDefined()
    expect(publish).not.toHaveBeenCalled()
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  /**
   * Chi crea ha visto l'avviso «nessuna policy SLA copre questo incident» e
   * l'ha accettato: l'incident lo registra (quando e chi), e la diagnostica
   * dei ticket senza SLA non lo conta. Senza accettazione i campi restano null.
   */
  it('acknowledgeNoSla → registra quando e chi ha accettato di crearlo senza SLA', async () => {
    await createIncident({ title: 'Stampante', severity: 'medium', affectedCIIds: ['ci-1'], acknowledgeNoSla: true }, ctx)
    const create = vi.mocked(runQuery).mock.calls.find(c => (c[1] as string).includes('CREATE (i:Incident'))!
    expect(create[1]).toContain('sla_absence_acknowledged_at: $ackAt')
    const params = create[2] as { ackAt: string | null; ackBy: string | null; now: string }
    expect(params.ackAt).toBe(params.now)
    expect(params.ackBy).toBe('user-1')
  })

  it('senza acknowledgeNoSla nessuna accettazione registrata', async () => {
    await createIncident({ title: 'Stampante', severity: 'medium', affectedCIIds: ['ci-1'] }, ctx)
    const create = vi.mocked(runQuery).mock.calls.find(c => (c[1] as string).includes('CREATE (i:Incident'))!
    expect(create[2]).toMatchObject({ ackAt: null, ackBy: null })
  })

  it('chiama publish con type incident.created', async () => {
    await createIncident(
      { title: 'Test incident', severity: 'high', affectedCIIds: ['ci-1'] },
      ctx,
    )

    expect(publish).toHaveBeenCalledOnce()
    const event = vi.mocked(publish).mock.calls[0]![0] as { type: string }
    expect(event.type).toBe('incident.created')
  })

  it('chiama workflowEngine.createInstance', async () => {
    await createIncident(
      { title: 'Test incident', severity: 'high', affectedCIIds: ['ci-1'] },
      ctx,
    )

    expect(workflowEngine.createInstance).toHaveBeenCalledOnce()
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(
      mockSession,
      ctx.tenantId,
      expect.any(String),  // generated uuid
      'incident',
      undefined,           // definitionId
      null,                // category
    )
  })

  /**
   * Revisione del 14 set 2026 · IT-4: il portale apre l'incident da qui. Unica
   * differenza dichiarata: l'utente finale non conosce i CI, quindi il canale
   * `portal` può nascere senza CI; la categoria però è obbligatoria e validata
   * contro il Dizionario (anche senza copia del cliente: IT-7).
   */
  it('canale portal: nasce senza CI, con created_by e canale, e pubblica incident.created', async () => {
    await createIncident({ title: 'Stampante', severity: 'high', category: 'hardware' }, ctx, 'portal')
    const create = vi.mocked(runQuery).mock.calls.find(c => (c[1] as string).includes('CREATE (i:Incident'))!
    expect(create[1]).toContain('created_by:   $userId')
    expect(create[2]).toMatchObject({ userId: 'user-1', channel: 'portal', category: 'hardware' })
    expect(vi.mocked(runQuery).mock.calls.some(c => (c[1] as string).includes('AFFECTED_BY'))).toBe(false)
    const event = vi.mocked(publish).mock.calls[0]![0] as { type: string }
    expect(event.type).toBe('incident.created')
    expect(workflowEngine.createInstance).toHaveBeenCalledOnce()
  })

  it('canale portal: categoria assente o fuori Dizionario → rifiutato prima di scrivere', async () => {
    await expect(createIncident({ title: 'T', severity: 'high' }, ctx, 'portal')).rejects.toThrow(/category is required/)
    await expect(createIncident({ title: 'T', severity: 'high', category: 'caffè' }, ctx, 'portal')).rejects.toThrow(/caffè/)
    await expect(createIncident({ title: 'T', severity: 'urgentissimo', category: 'hardware' }, ctx, 'portal')).rejects.toThrow(/urgentissimo/)
    expect(vi.mocked(runQuery).mock.calls.some(c => (c[1] as string).includes('CREATE (i:Incident'))).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('canale agent (default): il CI resta obbligatorio', async () => {
    await expect(createIncident({ title: 'T', severity: 'high', category: 'hardware' }, ctx)).rejects.toThrow(/at least one impacted CI/)
  })

  it('include tenantId e severity nell\'evento', async () => {
    // L'evento porta la gravità dell'incident CREATO (la priorità derivata):
    // il payload si rilegge dal grafo (B-7), quindi è la rilettura a dirla.
    primeIncidentRow({ id: 'inc-1', title: 'Alert critico', severity: 'critical', status: 'open' })
    const criticalRow = { get: (k: string) => (({ id: 'inc-1', title: 'Alert critico', severity: 'critical', status: 'open', ciName: 'srv-1', assignedTo: '—' }) as Record<string, string>)[k] }
    mockSession.executeRead.mockResolvedValue({ records: [criticalRow] })
    await createIncident(
      { title: 'Alert critico', severity: 'critical', affectedCIIds: ['ci-1'] },
      ctx,
    )

    const event = vi.mocked(publish).mock.calls[0]![0] as { tenant_id: string; payload: { severity: string } }
    expect(event.tenant_id).toBe('tenant-1')
    expect(event.payload.severity).toBe('critical')
  })
})

describe('resolveIncident', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([
      { props: { id: 'inc-1', title: 'Test incident', severity: 'high', status: 'resolved' } },
    ])
    // workflow-instance lookup
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'wi-1' })
    // loadIncidentPayload reloads the incident after the write — return a real row
    const payloadRow = { get: (k: string) => (({ id: 'inc-1', title: 'Test incident', severity: 'high', status: 'resolved', ciName: 'srv-1', assignedTo: 'Mario' }) as Record<string, string>)[k] }
    mockSession.executeRead.mockResolvedValue({ records: [payloadRow] })
  })

  it('chiama publish con type incident.resolved', async () => {
    await resolveIncident('inc-1', ctx, 'Root cause identificata')

    expect(publish).toHaveBeenCalledOnce()
    const event = vi.mocked(publish).mock.calls[0]![0] as { type: string }
    expect(event.type).toBe('incident.resolved')
  })

  it('include resolved_at nel payload', async () => {
    await resolveIncident('inc-1', ctx)

    const event = vi.mocked(publish).mock.calls[0]![0] as { payload: { resolved_at?: string } }
    expect(event.payload.resolved_at).toBeDefined()
  })
})

describe('escalateIncident', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // workflow-instance lookup
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'wi-1' })
    // loadIncidentPayload reloads the incident after the write — return a real row
    const payloadRow = { get: (k: string) => (({ id: 'inc-1', title: 'Test incident', severity: 'high', status: 'resolved', ciName: 'srv-1', assignedTo: 'Mario' }) as Record<string, string>)[k] }
    mockSession.executeRead.mockResolvedValue({ records: [payloadRow] })
  })

  it('chiama publish con type incident.escalated', async () => {
    await escalateIncident('inc-1', ctx)

    expect(publish).toHaveBeenCalledOnce()
    const event = vi.mocked(publish).mock.calls[0]![0] as { type: string }
    expect(event.type).toBe('incident.escalated')
  })

  it('include actor_id nell\'evento', async () => {
    await escalateIncident('inc-2', { tenantId: 'tenant-1', userId: 'admin-99' })

    const event = vi.mocked(publish).mock.calls[0]![0] as { actor_id: string }
    expect(event.actor_id).toBe('admin-99')
  })
})

/**
 * D-22 — l'identità dell'evento di transizione non è il NOME del passo, e
 * revisione totale · C-1 — la pubblicazione non vive più qui.
 *
 * I due eventi (il tipo stabile `incident.step_entered` e l'alias storico
 * `incident.<passo>`) nascono dall'hook `onStepEntered` del motore, che vede
 * anche i cammini automatici: il contratto è pinnato in
 * `src/lib/__tests__/stepEnteredPublisher.test.ts`. Qui resta la prova che il
 * servizio DELEGA, senza pubblicare nulla di suo (pubblicare in entrambi i
 * posti darebbe due notifiche per ogni transizione manuale).
 */
describe('publishIncidentTransition — delega al publisher condiviso (C-1)', () => {
  it('non pubblica eventi di suo: chiama il publisher dell\'ingresso nel passo', async () => {
    vi.clearAllMocks()
    await publishIncidentTransition('inc-1', 'in_attesa_fornitore', ctx)
    expect(publishStepEnteredForEntity).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', actorId: 'user-1', entityType: 'incident', entityId: 'inc-1', stepName: 'in_attesa_fornitore',
    }))
    expect(publish).not.toHaveBeenCalled()
  })
})
