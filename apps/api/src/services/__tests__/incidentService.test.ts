import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
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

// ── Import after mocks ────────────────────────────────────────────────────────

const { createIncident, resolveIncident, escalateIncident, publishIncidentTransition } = await import('../incidentService.js')
const { publish } = await import('@opengraphity/events')
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
  })

  it('rifiuta la creazione senza CI impattato', async () => {
    await expect(
      createIncident({ title: 'Senza CI', severity: 'high' }, ctx),
    ).rejects.toThrow(/almeno un CI/)
    await expect(
      createIncident({ title: 'CI vuoto', severity: 'high', affectedCIIds: [] }, ctx),
    ).rejects.toThrow(/almeno un CI/)
    expect(publish).not.toHaveBeenCalled()
  })

  // ── C-2 (CRITICO) ─────────────────────────────────────────────────────────
  // Il MERGE verso i CI impattati girava sotto il predicato con le etichette
  // FISSE e nessuno leggeva il risultato: zero righe = incident senza
  // AFFECTED_BY, senza errore e senza log, in contraddizione con la guardia
  // «almeno un CI impattato» tre righe sopra.
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
    ).rejects.toThrow(/Incident non creato: 1 dei 1 CI impattati.*ci-ignoto/)

    // L'incident committato in transazione propria viene rimosso: non resta in
    // banca dati un incident senza CI (e senza istanza di workflow).
    const cleanup = vi.mocked(runQuery).mock.calls
      .map(c => c[1] as string)
      .find(c => c.includes('DETACH DELETE i'))
    expect(cleanup, 'l\'incident non è stato annullato').toBeDefined()
    expect(publish).not.toHaveBeenCalled()
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
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

  it('include tenantId e severity nell\'evento', async () => {
    // The event carries the created incident's severity (derived priority) —
    // make the CREATE mock echo it.
    primeIncidentRow({ id: 'inc-1', title: 'Alert critico', severity: 'critical', status: 'open' })
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
 * D-22 — l'identità dell'evento di transizione non è più il NOME del passo.
 *
 * Prima: `publishEvent(\`incident.${stepName}\`, …)`. Dopo una rinomina l'API
 * pubblicava `incident.lavorazione`, nessuna regola di notifica
 * corrispondeva, nessun webhook aveva quel tipo, e niente lo diceva.
 *
 * Ora vengono pubblicati DUE eventi con lo stesso payload e lo stesso
 * istante: il tipo **stabile** `incident.step_entered` (col passo nel
 * payload: nome, etichetta, scopo, categoria, id) e l'**alias** storico
 * `incident.<passo>`, mantenuto perché a lui sono agganciate le 35 regole di
 * fabbrica, le regole già scritte dai tenant e i formatter Slack/Teams (che
 * sono per tipo esatto). Il dispatcher non consegna due volte.
 */
describe('publishIncidentTransition — tipo stabile + alias storico', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const payloadRow = { get: (k: string) => (({ id: 'inc-1', title: 'DB down', severity: 'high', status: 'in_attesa_fornitore', ciName: 'srv-1', assignedTo: 'Mario' }) as Record<string, string>)[k] }
    mockSession.executeRead.mockResolvedValue({ records: [payloadRow] })
    vi.mocked(runQueryOne).mockResolvedValue({ stepId: 'st-7', label: 'In attesa del fornitore', purpose: null, category: 'waiting' })
  })

  it('pubblica il tipo stabile E l\'alias del passo rinominato, con gli stessi fatti del passo', async () => {
    await publishIncidentTransition('inc-1', 'in_attesa_fornitore', ctx)

    const types = vi.mocked(publish).mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toEqual(['incident.step_entered', 'incident.in_attesa_fornitore'])
    for (const call of vi.mocked(publish).mock.calls) {
      const payload = (call[0] as { payload: Record<string, unknown> }).payload
      expect(payload).toMatchObject({
        id: 'inc-1', title: 'DB down',
        step_id: 'st-7', step_name: 'in_attesa_fornitore', step_label: 'In attesa del fornitore',
        step_purpose: null, step_category: 'waiting',
      })
    }
    // stesso istante: le due pubblicazioni sono la STESSA transizione
    const [a, b] = vi.mocked(publish).mock.calls.map((c) => (c[0] as { timestamp: string }).timestamp)
    expect(a).toBe(b)
  })

  it('un passo che non esiste nel workflow attivo ferma l\'evento invece di inventarne i fatti', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    await expect(publishIncidentTransition('inc-1', 'fantasma', ctx)).rejects.toThrow(/"fantasma"/)
    expect(publish).not.toHaveBeenCalled()
  })
})
