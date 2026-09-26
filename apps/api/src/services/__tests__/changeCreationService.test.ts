import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Session mock usato da withSession ─────────────────────────────────────────
// executeWrite invoca la callback con una ManagedTransaction mock: il service
// esegue TUTTE le scritture (CREATE change, workflow instance, audit) dentro
// un'unica executeWrite via tx.run.

const mockTx = {
  run: vi.fn().mockResolvedValue({ records: [] }),
}

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockImplementation(
    async (work: (tx: typeof mockTx) => Promise<unknown>) => work(mockTx),
  ),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
// Ondata 6 di «Nulla cablato»: il formato dei numeri è del cliente; qui quello di fabbrica.
vi.mock('../../lib/ticketCIExclusions.js', () => import('../../lib/__tests__/ticketCIExclusionsFake.js'))
vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))
// The creation's event is recorded in its transaction and published after (wave 7 · B2).
vi.mock('../../lib/publishEvent.js', () => import('../../lib/__tests__/publishEventFake.js'))
// CH-2: i codici vengono dai contatori atomici; qui il contatore change parte da maxChgNum.
let maxChgNum = 0
let taskCounter = 0
vi.mock('../../lib/sequence.js', () => ({
  nextSequenceValue: vi.fn(async () => ++maxChgNum),
  nextSequenceBlock: vi.fn(async (_s: unknown, _t: string, _k: string, count: number) => (taskCounter += count)),
}))
// The tenant's pre-approved change types: the factory list (lib/changePolicy.ts).
vi.mock('../../lib/changePolicy.js', () => ({
  isPreApprovedChangeType: vi.fn(async (_t: string, type: string | null | undefined) => type === 'standard'),
}))
vi.mock('@opengraphity/sla', () => ({
  getActiveOLAContractsFor: vi.fn(async () => []), getTenantTimezone: vi.fn(async () => 'UTC'),
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

vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('assessment'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

vi.mock('../../lib/db.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn((p: Record<string, unknown>) => p),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { createChangeRFC } = await import('../changeCreationService.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { runQuery } = await import('../../lib/db.js')

// ── Test context ──────────────────────────────────────────────────────────────

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }

/**
 * Dispatch runQuery by query content — the service (via change/helpers.js)
 * runs, in order: assertCIHasOwnerAndSupport, nextChangeCode, getNextTaskCodes.
 */
function mockQueries(opts: {
  ciRows?: Array<{ id: string; name: string; ownerTeamId: string | null; supportTeamId: string | null }>
  maxChgNum?: number
}) {
  maxChgNum = opts.maxChgNum ?? 0
  taskCounter = 0
  vi.mocked(runQuery).mockImplementation(async (_session: unknown, query: string) => {
    if (query.includes('OWNED_BY') && query.includes('SUPPORTED_BY')) {
      return (opts.ciRows ?? []) as never
    }
    if (query.includes("STARTS WITH 'CHG'")) {
      return [{ maxNum: opts.maxChgNum ?? 0 }] as never
    }
    if (query.includes("STARTS WITH 'TASK'")) {
      return [] as never
    }
    return [] as never
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createChangeRFC', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockTx.run.mockResolvedValue({ records: [] })
    mockSession.executeWrite.mockImplementation(
      async (work: (tx: typeof mockTx) => Promise<unknown>) => work(mockTx),
    )
    // The owner named is an active person of the tenant (review of 23 Sep 2026).
    const { runQueryOne } = await import('@opengraphity/neo4j')
    vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string, params?: Record<string, unknown>) =>
      (cypher.includes('MATCH (u:User {id: $ownerId') ? { id: params?.['ownerId'] } : null)) as never)
  })

  it('an owner who is not an active person of the tenant is refused before anything is written', async () => {
    const { runQueryOne } = await import('@opengraphity/neo4j')
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    mockQueries({ ciRows: [{ id: 'ci-1', name: 'db-01', ownerTeamId: 't-1', supportTeamId: 't-2' }] })
    await expect(
      createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', why: 'w', what: 'x', affectedCIIds: ['ci-1'], changeOwner: 'user-ghost' }, ctx),
    ).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.change.ownerNotFound' } } })
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  // Verifica «Cosa resta cablato», ondata 1: nessun tipo di ripiego.
  it('rifiuta un change senza tipo, prima di toccare il grafo', async () => {
    await expect(
      createChangeRFC({ title: 'Upgrade DB', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow(/changeType is required/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  // Review of 23 Sep 2026: an id that is not a CI of the tenant was dropped, and the change created without it.
  it('an unknown CI is refused, naming it, before anything is written', async () => {
    mockQueries({ ciRows: [{ id: 'ci-1', name: 'db-01', ownerTeamId: 't-1', supportTeamId: 't-2' }] })
    await expect(
      createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', why: 'w', what: 'x', affectedCIIds: ['ci-1', 'typo'] }, ctx),
    ).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.ci.notFoundIds', params: { ids: 'typo' } } } })
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('rifiuta un change senza CI impattati', async () => {
    await expect(
      createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', affectedCIIds: [] }, ctx),
    ).rejects.toThrow('A change must have at least one impacted CI')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('rifiuta un change senza title', async () => {
    await expect(
      createChangeRFC({ changeType: 'normal', title: '  ', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow('title is required')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('rifiuta un change senza WHY o senza WHAT', async () => {
    await expect(
      createChangeRFC({ changeType: 'normal', title: 'X', why: '  ', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow(/why/i)
    await expect(
      createChangeRFC({ changeType: 'normal', title: 'X', why: 'perché', what: '  ', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow(/what/i)
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('rifiuta se un CI non ha Owner Group, con il CI mancante nel messaggio', async () => {
    mockQueries({
      ciRows: [
        { id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' },
        { id: 'ci-2', name: 'DB Prod',     ownerTeamId: null,     supportTeamId: 'team-b' },
      ],
    })
    await expect(
      createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1', 'ci-2'] }, ctx),
    ).rejects.toThrow('CI DB Prod has no Owner Group or Support Group')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('rifiuta se un CI non ha Support Group', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: null }],
    })
    await expect(
      createChangeRFC({ changeType: 'normal', title: 'Upgrade', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow('CI App Portale has no Owner Group or Support Group')
  })

  // Wave 7 · B2: `change.created` exists if and only if the change does.
  it('change.created is written to the outbox in the creation\'s transaction, and that event is published', async () => {
    const { recordDomainEventIn, publishDomainEvent } = await import('../../lib/__tests__/publishEventFake.js')
    mockQueries({ ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }], maxChgNum: 41 })
    const created = await createChangeRFC({ changeType: 'normal', title: 'Upgrade', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx)
    expect(created).toEqual({ id: expect.any(String), code: expect.any(String) })
    expect(recordDomainEventIn).toHaveBeenCalledWith(mockTx, expect.objectContaining({
      type: 'change.created', payload: { id: created.id, code: created.code, title: 'Upgrade', change_type: 'normal' },
    }))
    expect(publishDomainEvent).toHaveBeenCalledWith(vi.mocked(recordDomainEventIn).mock.calls[0]![1])
  })

  it('crea il change: id + code progressivo, tasks, workflow instance e audit', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }],
      maxChgNum: 41,
    })

    const result = await createChangeRFC(
      { changeType: 'normal', title: 'Upgrade DB', why: 'perché', what: 'cosa', changeOwner: 'user-9', affectedCIIds: ['ci-1'] },
      ctx,
    )

    expect(result.id).toEqual(expect.any(String))
    expect(result.code).toBe('CHG00000042')

    // UNICA executeWrite: CREATE del Change + task, workflow instance e audit
    // partecipano tutte alla stessa transazione
    expect(mockSession.executeWrite).toHaveBeenCalledTimes(1)

    // Dentro la tx: tx.run per la CREATE (change e piani), per gli assessment
    // e per l'audit (l'instance è mockata)
    expect(mockTx.run).toHaveBeenCalledTimes(3)
    expect(mockTx.run.mock.calls[0]![0]).toContain('CREATE (c:Change')
    expect(mockTx.run.mock.calls[0]![0]).toContain('DeployPlanTask')
    expect(mockTx.run.mock.calls[1]![0]).toContain('AssessmentTask')
    expect(mockTx.run.mock.calls[2]![0]).toContain('ChangeAuditEntry')

    expect(workflowEngine.createInstance).toHaveBeenCalledOnce()
    // createInstance riceve la ManagedTransaction, NON la session: partecipa alla tx
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(
      mockTx, ctx.tenantId, result.id, 'change',
    )
  })

  /**
   * Giro nel browser del 14 set 2026 (#37): chi apre un incident, un problem o
   * una richiesta la segue da subito; chi apre una change no, e non riceveva
   * le notifiche ai watcher. L'arco nasce nella STESSA transazione della change.
   */
  it('chi apre la change la segue (WATCHES nella stessa transazione)', async () => {
    mockQueries({ ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }] })
    await createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx)
    const [cypher, params] = mockTx.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toMatch(/MERGE \(req\)-\[w:WATCHES\]->\(c\)\s+ON CREATE SET w.watched_at = \$now/)
    expect(params).toMatchObject({ requesterId: 'user-1', tenantId: 'tenant-1' })
  })

  /** Secondo giro UI del 15 set 2026, punto 3: gli OLA/UC li controlla la passata dell'API sul tempo del team. */
  it('la creazione di una change non arma controlli OLA/UC', async () => {
    mockQueries({ ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }] })
    const sla = await import('@opengraphity/sla')
    await createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx)
    expect(sla.getActiveOLAContractsFor).not.toHaveBeenCalled()
  })

  it('rollback: executeWrite che fallisce → l\'errore propaga, nessuna scrittura osservabile', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }],
    })
    // La tx fallisce in blocco (es. deadlock): il driver non committa nulla.
    mockSession.executeWrite.mockRejectedValue(new Error('Neo.TransientError.Transaction.DeadlockDetected'))

    await expect(
      createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow('DeadlockDetected')

    // UNICA executeWrite = unica unità di commit: fallita quella, non esistono
    // scritture parziali fuori dalla tx (nessun tx.run eseguito, niente workflow)
    expect(mockSession.executeWrite).toHaveBeenCalledTimes(1)
    expect(mockTx.run).not.toHaveBeenCalled()
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('rollback: prima statement della tx che fallisce → niente workflow instance né audit', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }],
    })
    mockTx.run.mockRejectedValueOnce(new Error('constraint violation'))

    await expect(
      createChangeRFC({ changeType: 'normal', title: 'Upgrade DB', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow('constraint violation')

    // dentro la stessa tx nulla prosegue dopo la statement fallita:
    // né createInstance né la seconda tx.run (audit)
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
    expect(mockTx.run).toHaveBeenCalledTimes(1)
  })

  it('il code generato rispetta il formato CHG + 8 cifre zero-padded', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }],
      maxChgNum: 7,
    })

    const result = await createChangeRFC({ changeType: 'normal', title: 'Upgrade', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1'] }, ctx)

    expect(result.code).toMatch(/^CHG\d{8}$/)
    expect(result.code).toBe('CHG00000008')
  })

  /**
   * THE OWNER, 25 Sep 2026: «le change standard: viene chiesto solo il piano,
   * niente funzionale e niente tecnico». A pre-approved change gets one task
   * per CI, the release plan, and a code for it alone.
   */
  it('a pre-approved change asks only for the release plan: no assessment, one task code per CI', async () => {
    mockQueries({
      ciRows: [
        { id: 'ci-1', name: 'A', ownerTeamId: 't1', supportTeamId: 't2' },
        { id: 'ci-2', name: 'B', ownerTeamId: 't1', supportTeamId: 't2' },
      ],
    })
    await createChangeRFC({ changeType: 'standard', title: 'Add indexes', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1', 'ci-2'] }, ctx)
    const cyphers = mockTx.run.mock.calls.map((c) => c[0] as string)
    expect(cyphers.some((q) => q.includes('AssessmentTask'))).toBe(false)
    expect(cyphers[0]).toContain('DeployPlanTask')
    const params = mockTx.run.mock.calls[0]![1] as { ciTasks: Array<Record<string, unknown>> }
    expect(params.ciTasks).toEqual([
      { ciId: 'ci-1', ownerCode: null, supportCode: null, planCode: 'TASK00000001' },
      { ciId: 'ci-2', ownerCode: null, supportCode: null, planCode: 'TASK00000002' },
    ])
    expect(workflowEngine.createInstance).toHaveBeenCalledOnce()
  })

  it('passa un task code per ogni ruolo (owner/support/plan) per ciascun CI', async () => {
    mockQueries({
      ciRows: [
        { id: 'ci-1', name: 'A', ownerTeamId: 't1', supportTeamId: 't2' },
        { id: 'ci-2', name: 'B', ownerTeamId: 't1', supportTeamId: 't2' },
      ],
    })

    await createChangeRFC({ changeType: 'normal', title: 'Multi CI', why: 'perché', what: 'cosa', affectedCIIds: ['ci-1', 'ci-2'] }, ctx)

    // La prima tx.run dentro l'unica executeWrite è la CREATE: ispeziona i parametri
    const params = mockTx.run.mock.calls[0]![1] as { ciTasks: Array<{ ciId: string; ownerCode: string; supportCode: string; planCode: string }> }
    expect(params.ciTasks).toHaveLength(2)
    expect(params.ciTasks[0]).toMatchObject({
      ciId: 'ci-1', ownerCode: 'TASK00000001', supportCode: 'TASK00000002', planCode: 'TASK00000003',
    })
    expect(params.ciTasks[1]).toMatchObject({
      ciId: 'ci-2', ownerCode: 'TASK00000004', supportCode: 'TASK00000005', planCode: 'TASK00000006',
    })
  })
})
