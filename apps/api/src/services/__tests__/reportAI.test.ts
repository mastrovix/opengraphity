import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))

const { runGuardedCypherTool, ToolLoopBudget, REPORT_AI_LIMITS } = await import('../reportAI.js')
const { getSession } = await import('@opengraphity/neo4j')

function makeSession(rows: Array<Record<string, unknown>> = []) {
  const run = vi.fn().mockResolvedValue({
    records: rows.map(r => ({ keys: Object.keys(r), get: (k: string) => r[k] })),
  })
  return {
    run,
    executeRead: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({ run })),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

describe('runGuardedCypherTool (C-02)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs a safe query in a READ session with only $tenantId', async () => {
    const session = makeSession([{ title: 'DB down', n: { toNumber: () => 3 } }])
    vi.mocked(getSession).mockReturnValue(session as never)
    const budget = new ToolLoopBudget()

    const out = await runGuardedCypherTool('MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.title AS title, count(i) AS n', 't1', budget, 'test')

    expect(getSession).toHaveBeenCalledWith(undefined, 'READ')
    expect(session.run).toHaveBeenCalledWith(expect.stringContaining('MATCH (i:Incident {tenant_id: $tenantId})'), { tenantId: 't1' })
    expect(JSON.parse(out)).toEqual([{ title: 'DB down', n: 3 }])
    expect(budget.rejections).toBe(0)
    expect(session.close).toHaveBeenCalled()
  })

  it('an unsafe query is NOT executed; the reason goes back to the model', async () => {
    const session = makeSession()
    vi.mocked(getSession).mockReturnValue(session as never)
    const budget = new ToolLoopBudget()

    const out = await runGuardedCypherTool('MATCH (u:User) RETURN u.email, u.tenant_id', 't1', budget, 'test')

    expect(session.run).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
    expect(out).toContain('Query rifiutata')
    expect(out).toContain('tenant_id: $tenantId')
    expect(budget.rejections).toBe(1)
  })

  it('write clauses are rejected even with a tenant filter', async () => {
    const session = makeSession()
    vi.mocked(getSession).mockReturnValue(session as never)
    const out = await runGuardedCypherTool('MATCH (i:Incident {tenant_id: $tenantId}) SET i.status = "closed" RETURN i', 't1', new ToolLoopBudget(), 'test')
    expect(session.run).not.toHaveBeenCalled()
    expect(out).toContain('SET')
  })

  it(`after ${REPORT_AI_LIMITS.maxRejections} rejections the next one fails the request`, async () => {
    vi.mocked(getSession).mockReturnValue(makeSession() as never)
    const budget = new ToolLoopBudget()
    const bad = 'MATCH (u:User) RETURN u.email'
    for (let i = 0; i < REPORT_AI_LIMITS.maxRejections; i++) {
      await expect(runGuardedCypherTool(bad, 't1', budget, 'test')).resolves.toContain('Query rifiutata')
    }
    await expect(runGuardedCypherTool(bad, 't1', budget, 'test')).rejects.toThrow(/rifiutata 3 volte/)
  })

  it('Neo4j errors are returned to the model (not thrown) and do not count as rejections', async () => {
    const session = makeSession()
    session.run.mockRejectedValue(new Error('Invalid input'))
    vi.mocked(getSession).mockReturnValue(session as never)
    const budget = new ToolLoopBudget()
    const out = await runGuardedCypherTool('MATCH (i:Incident {tenant_id: $tenantId}) RETURN i.nope', 't1', budget, 'test')
    expect(out).toContain('Errore query: Invalid input')
    expect(budget.rejections).toBe(0)
    expect(session.close).toHaveBeenCalled()
  })
})

describe('ToolLoopBudget (C-08)', () => {
  it('caps tool iterations', () => {
    const b = new ToolLoopBudget()
    for (let i = 0; i < REPORT_AI_LIMITS.maxIterations; i++) b.beforeToolCall()
    expect(() => b.beforeToolCall()).toThrow(/limite di 8 query/)
  })

  it('caps cumulative output tokens', () => {
    const b = new ToolLoopBudget()
    b.recordUsage(REPORT_AI_LIMITS.maxOutputTokens + 1)
    expect(() => b.beforeModelCall()).toThrow(/budget token/)
  })

  it('ignores non-numeric usage and passes when within budget', () => {
    const b = new ToolLoopBudget()
    b.recordUsage(undefined)
    b.recordUsage(Number.NaN)
    b.recordUsage(100)
    expect(b.outputTokens).toBe(100)
    expect(() => b.beforeModelCall()).not.toThrow()
  })

  it('caps wall-clock time', () => {
    const b = new ToolLoopBudget({ ...REPORT_AI_LIMITS, maxDurationMs: -1 })
    expect(() => b.beforeModelCall()).toThrow(/budget di tempo/)
  })
})
