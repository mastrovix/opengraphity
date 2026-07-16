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

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))

vi.mock('../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('assessment'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
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
const { runQuery } = await import('../../graphql/resolvers/ci-utils.js')

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
  beforeEach(() => {
    vi.clearAllMocks()
    mockTx.run.mockResolvedValue({ records: [] })
    mockSession.executeWrite.mockImplementation(
      async (work: (tx: typeof mockTx) => Promise<unknown>) => work(mockTx),
    )
  })

  it('rifiuta un change senza CI impattati', async () => {
    await expect(
      createChangeRFC({ title: 'Upgrade DB', affectedCIIds: [] }, ctx),
    ).rejects.toThrow('Un change deve avere almeno un CI impattato')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('rifiuta un change senza title', async () => {
    await expect(
      createChangeRFC({ title: '  ', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow('title è obbligatorio')
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
      createChangeRFC({ title: 'Upgrade DB', affectedCIIds: ['ci-1', 'ci-2'] }, ctx),
    ).rejects.toThrow('CI DB Prod manca di Owner Group o Support Group')
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('rifiuta se un CI non ha Support Group', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: null }],
    })
    await expect(
      createChangeRFC({ title: 'Upgrade', affectedCIIds: ['ci-1'] }, ctx),
    ).rejects.toThrow('CI App Portale manca di Owner Group o Support Group')
  })

  it('crea il change: id + code progressivo, tasks, workflow instance e audit', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }],
      maxChgNum: 41,
    })

    const result = await createChangeRFC(
      { title: 'Upgrade DB', description: 'desc', changeOwner: 'user-9', affectedCIIds: ['ci-1'] },
      ctx,
    )

    expect(result.id).toEqual(expect.any(String))
    expect(result.code).toBe('CHG00000042')

    // UNICA executeWrite: CREATE del Change + task, workflow instance e audit
    // partecipano tutte alla stessa transazione
    expect(mockSession.executeWrite).toHaveBeenCalledTimes(1)

    // Dentro la tx: tx.run per la CREATE e per l'audit (l'instance è mockata)
    expect(mockTx.run).toHaveBeenCalledTimes(2)
    expect(mockTx.run.mock.calls[0]![0]).toContain('CREATE (c:Change')
    expect(mockTx.run.mock.calls[1]![0]).toContain('ChangeAuditEntry')

    expect(workflowEngine.createInstance).toHaveBeenCalledOnce()
    // createInstance riceve la ManagedTransaction, NON la session: partecipa alla tx
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(
      mockTx, ctx.tenantId, result.id, 'change',
    )
  })

  it('rollback: executeWrite che fallisce → l\'errore propaga, nessuna scrittura osservabile', async () => {
    mockQueries({
      ciRows: [{ id: 'ci-1', name: 'App Portale', ownerTeamId: 'team-a', supportTeamId: 'team-b' }],
    })
    // La tx fallisce in blocco (es. deadlock): il driver non committa nulla.
    mockSession.executeWrite.mockRejectedValue(new Error('Neo.TransientError.Transaction.DeadlockDetected'))

    await expect(
      createChangeRFC({ title: 'Upgrade DB', affectedCIIds: ['ci-1'] }, ctx),
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
      createChangeRFC({ title: 'Upgrade DB', affectedCIIds: ['ci-1'] }, ctx),
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

    const result = await createChangeRFC({ title: 'Upgrade', affectedCIIds: ['ci-1'] }, ctx)

    expect(result.code).toMatch(/^CHG\d{8}$/)
    expect(result.code).toBe('CHG00000008')
  })

  it('passa un task code per ogni ruolo (owner/support/plan) per ciascun CI', async () => {
    mockQueries({
      ciRows: [
        { id: 'ci-1', name: 'A', ownerTeamId: 't1', supportTeamId: 't2' },
        { id: 'ci-2', name: 'B', ownerTeamId: 't1', supportTeamId: 't2' },
      ],
    })

    await createChangeRFC({ title: 'Multi CI', affectedCIIds: ['ci-1', 'ci-2'] }, ctx)

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
