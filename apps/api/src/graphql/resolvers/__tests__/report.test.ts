/**
 * Report assistant conversations (graphql/resolvers/report.ts).
 *
 * Why these behaviours matter:
 *  - conversations hold questions about a customer's data and the answers the
 *    AI gave: every read, the message list and the delete are matched on the
 *    caller's tenant AND on the caller, or one person could read or wipe a
 *    colleague's history (they were tenant-wide until 23 Sep 2026);
 *  - asking the assistant runs model-generated (guarded) Cypher, so it is
 *    reserved to roles with `report.ai` — a viewer must be refused before any
 *    session is opened or any AI call is made;
 *  - the AI is asked for the caller's tenant, never another one;
 *  - sessions are always closed, even when the query or the AI fails, or the
 *    driver pool is exhausted after a few errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txRun = vi.fn()
const close = vi.fn(async () => {})
const getSession = vi.fn((..._a: unknown[]) => ({
  close,
  executeRead: (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun }),
  executeWrite: (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun }),
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: (...a: unknown[]) => getSession(...a) }))

const callReportAI = vi.fn()
vi.mock('../../../services/reportAI.js', () => ({ callReportAI: (...a: unknown[]) => callReportAI(...a) }))
const runReportConversation = vi.fn()
vi.mock('../../../services/reportConversation.js', () => ({ runReportConversation: (...a: unknown[]) => runReportConversation(...a) }))

const { reportResolvers } = await import('../report.js')

const ctx = (...perms: string[]) => ({ tenantId: 't1', userId: 'u1', role: 'operator', permissions: new Set(perms) }) as never
const records = (...props: Record<string, unknown>[]) => ({ records: props.map((p) => ({ get: () => p })) })

beforeEach(() => {
  txRun.mockReset(); close.mockClear(); getSession.mockClear(); callReportAI.mockReset(); runReportConversation.mockReset()
})

describe('Query.reportConversations', () => {
  it("lists the caller's own conversations, mapped to camelCase", async () => {
    txRun.mockResolvedValueOnce(records({ id: 'c1', title: 'Open P1', created_at: '2026-09-01', updated_at: '2026-09-02', extra: 'x' }))
    const out = await reportResolvers.Query.reportConversations(null, null, ctx())
    expect(out).toEqual([{ id: 'c1', title: 'Open P1', createdAt: '2026-09-01', updatedAt: '2026-09-02' }])
    expect(txRun.mock.calls[0]![0]).toContain('user_id: $userId')
    expect(txRun.mock.calls[0]![1]).toEqual({ tenantId: 't1', userId: 'u1' })
    expect(getSession).toHaveBeenCalledWith(undefined, 'READ')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('Query.reportConversation', () => {
  it("returns one of the caller's conversations", async () => {
    txRun.mockResolvedValueOnce(records({ id: 'c1', title: 'T', created_at: 'a', updated_at: 'b' }))
    await expect(reportResolvers.Query.reportConversation(null, { id: 'c1' }, ctx())).resolves.toMatchObject({ id: 'c1', title: 'T' })
    expect(txRun.mock.calls[0]![0]).toContain('user_id: $userId')
    expect(txRun.mock.calls[0]![1]).toEqual({ id: 'c1', tenantId: 't1', userId: 'u1' })
  })

  it("returns null for an id that is not the caller's (another tenant or a colleague)", async () => {
    txRun.mockResolvedValueOnce(records())
    await expect(reportResolvers.Query.reportConversation(null, { id: 'other' }, ctx())).resolves.toBeNull()
  })

  it('closes the session when the read fails', async () => {
    txRun.mockRejectedValueOnce(new Error('db down'))
    await expect(reportResolvers.Query.reportConversation(null, { id: 'c1' }, ctx())).rejects.toThrow('db down')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('Mutation.askReport', () => {
  it('refuses a role without report.ai before touching the database or the AI', async () => {
    await expect(reportResolvers.Mutation.askReport(null, { question: 'How many P1?' }, ctx('report.read')))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.authz.permissionRequired' } } })
    expect(getSession).not.toHaveBeenCalled()
    expect(runReportConversation).not.toHaveBeenCalled()
  })

  it('runs the conversation for the caller tenant and asks the AI for that tenant', async () => {
    runReportConversation.mockImplementationOnce(async (opts: { ask: (h: unknown[], q: string) => Promise<unknown> }) => {
      const message = await opts.ask([{ role: 'user', content: 'before' }], 'How many P1?')
      return { conversationId: 'c9', message }
    })
    callReportAI.mockResolvedValueOnce({ id: 'm1', role: 'assistant', content: '3' })
    const out = await reportResolvers.Mutation.askReport(null, { question: 'How many P1?', conversationId: 'c9' }, ctx('report.ai'))
    expect(out).toEqual({ conversationId: 'c9', message: { id: 'm1', role: 'assistant', content: '3' } })
    expect(runReportConversation.mock.calls[0]![0]).toMatchObject({ tenantId: 't1', userId: 'u1', question: 'How many P1?', conversationId: 'c9' })
    expect(callReportAI).toHaveBeenCalledWith('t1', expect.any(String), [{ role: 'user', content: 'before' }], 'How many P1?')
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the session when the AI fails', async () => {
    runReportConversation.mockRejectedValueOnce(new Error('AI unavailable'))
    await expect(reportResolvers.Mutation.askReport(null, { question: 'q' }, ctx('report.ai'))).rejects.toThrow('AI unavailable')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('Mutation.deleteReportConversation', () => {
  it("deletes the conversation and its messages only if it is the caller's", async () => {
    txRun.mockResolvedValueOnce(records())
    await expect(reportResolvers.Mutation.deleteReportConversation(null, { id: 'c1' }, ctx())).resolves.toBe(true)
    const [cypher, params] = txRun.mock.calls[0]!
    expect(cypher).toContain('DETACH DELETE c, m')
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(cypher).toContain('user_id: $userId')
    expect(params).toEqual({ id: 'c1', tenantId: 't1', userId: 'u1' })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('ReportConversation.messages', () => {
  it("returns the messages only of the caller's conversation, mapped", async () => {
    txRun.mockResolvedValueOnce(records(
      { id: 'm1', role: 'user', content: 'q', created_at: '1' },
      { id: 'm2', role: 'assistant', content: 'a', created_at: '2' },
    ))
    const out = await reportResolvers.ReportConversation.messages({ id: 'c1' }, null, ctx())
    expect(out).toEqual([
      { id: 'm1', role: 'user', content: 'q', createdAt: '1' },
      { id: 'm2', role: 'assistant', content: 'a', createdAt: '2' },
    ])
    expect(txRun.mock.calls[0]![0]).toContain('user_id: $userId')
    expect(txRun.mock.calls[0]![1]).toEqual({ id: 'c1', tenantId: 't1', userId: 'u1' })
  })
})
