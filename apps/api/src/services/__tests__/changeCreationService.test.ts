import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
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
    mockSession.executeWrite.mockResolvedValue({ records: [] })
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

    // CREATE del Change + task per CI (prima executeWrite) e audit (seconda)
    expect(mockSession.executeWrite).toHaveBeenCalledTimes(2)

    expect(workflowEngine.createInstance).toHaveBeenCalledOnce()
    expect(workflowEngine.createInstance).toHaveBeenCalledWith(
      mockSession, ctx.tenantId, result.id, 'change',
    )
  })

  it('passa un task code per ogni ruolo (owner/support/plan) per ciascun CI', async () => {
    mockQueries({
      ciRows: [
        { id: 'ci-1', name: 'A', ownerTeamId: 't1', supportTeamId: 't2' },
        { id: 'ci-2', name: 'B', ownerTeamId: 't1', supportTeamId: 't2' },
      ],
    })

    await createChangeRFC({ title: 'Multi CI', affectedCIIds: ['ci-1', 'ci-2'] }, ctx)

    // La prima executeWrite è la CREATE: ispeziona i parametri passati a tx.run
    const writeFn = mockSession.executeWrite.mock.calls[0]![0] as (tx: { run: ReturnType<typeof vi.fn> }) => Promise<unknown>
    const txRun = vi.fn().mockResolvedValue({ records: [] })
    await writeFn({ run: txRun })
    const params = txRun.mock.calls[0]![1] as { ciTasks: Array<{ ciId: string; ownerCode: string; supportCode: string; planCode: string }> }
    expect(params.ciTasks).toHaveLength(2)
    expect(params.ciTasks[0]).toMatchObject({
      ciId: 'ci-1', ownerCode: 'TASK00000001', supportCode: 'TASK00000002', planCode: 'TASK00000003',
    })
    expect(params.ciTasks[1]).toMatchObject({
      ciId: 'ci-2', ownerCode: 'TASK00000004', supportCode: 'TASK00000005', planCode: 'TASK00000006',
    })
  })
})
