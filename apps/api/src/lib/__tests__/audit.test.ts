/**
 * lib/audit.ts — the single writer of Audit Log entries.
 *
 * Why these behaviours matter:
 *  - every entry must carry the caller's tenant: an entry written without it
 *    (or under another tenant) is either invisible to the customer's auditors
 *    or visible to the wrong customer;
 *  - an audit that cannot be written must NEVER fail the caller nor escape as
 *    an unhandled rejection (callers use `void audit(...)`, and on Node 24 an
 *    unhandled rejection kills the process) — not even when `getSession()`
 *    itself throws;
 *  - a failed write is recorded in the request's audit scope, so the mutation
 *    registry still writes a generic entry instead of leaving a silent hole.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { audit } = await import('../audit.js')
const { runInAuditScope, auditsWrittenInScope, auditsFailedInScope } = await import('../auditScope.js')
const { getSession } = await import('@opengraphity/neo4j')
const { logger } = await import('../logger.js')

type Ctx = Parameters<typeof audit>[0]
const ctx = { tenantId: 'tenant-a', userId: 'user-1', userEmail: 'ann@example.test' } as unknown as Ctx

function fakeSession(run: (cypher: string, params: Record<string, unknown>) => unknown = () => ({ records: [] })) {
  const tx = { run: vi.fn(run) }
  return {
    tx,
    executeWrite: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn(async () => undefined),
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('audit — the written entry', () => {
  it('creates one AuditEntry scoped to the caller tenant, with actor, entity, JSON details and IP', async () => {
    const s = fakeSession()
    vi.mocked(getSession).mockReturnValue(s as never)

    await audit(ctx, 'incident.updated', 'incident', 'inc-1', { field: 'status', to: 'closed' }, '10.0.0.1')

    // A write session: an entry in a read replica would be lost.
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(s.tx.run).toHaveBeenCalledTimes(1)
    const [cypher, params] = s.tx.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('CREATE (a:AuditEntry')
    expect(params).toMatchObject({
      tenantId: 'tenant-a', userId: 'user-1', userEmail: 'ann@example.test',
      action: 'incident.updated', entityType: 'incident', entityId: 'inc-1',
      ipAddress: '10.0.0.1',
    })
    // Details are stored as a JSON string: Neo4j cannot store nested maps.
    expect(JSON.parse(params['details'] as string)).toEqual({ field: 'status', to: 'closed' })
    expect(params['id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(params['createdAt'] as string))).toBe(false)
    expect(s.close).toHaveBeenCalledTimes(1)
  })

  it('without details or IP it writes explicit nulls, not the strings "undefined"', async () => {
    const s = fakeSession()
    vi.mocked(getSession).mockReturnValue(s as never)
    await audit(ctx, 'team.deleted', 'team', 'team-9')
    const params = s.tx.run.mock.calls[0]![1] as Record<string, unknown>
    expect(params['details']).toBeNull()
    expect(params['ipAddress']).toBeNull()
  })

  it('each entry gets its own id', async () => {
    const s = fakeSession()
    vi.mocked(getSession).mockReturnValue(s as never)
    await audit(ctx, 'a', 'x', '1')
    await audit(ctx, 'a', 'x', '1')
    const ids = s.tx.run.mock.calls.map((c) => (c[1] as Record<string, unknown>)['id'])
    expect(new Set(ids).size).toBe(2)
  })
})

describe('audit — failures never reach the caller', () => {
  it('a failing write resolves, closes the session and logs at error level', async () => {
    const s = fakeSession(() => { throw new Error('neo4j down') })
    vi.mocked(getSession).mockReturnValue(s as never)

    await expect(audit(ctx, 'incident.updated', 'incident', 'inc-1')).resolves.toBeUndefined()
    expect(s.close).toHaveBeenCalledTimes(1)
    // A hole in the Audit Log is a defect, not a warning.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'incident.updated', tenantId: 'tenant-a' }),
      expect.stringContaining('no entry in the Audit Log'),
    )
  })

  it('getSession() throwing is caught too (it used to escape as an unhandled rejection)', async () => {
    vi.mocked(getSession).mockImplementation(() => { throw new Error('driver not initialised') })
    await expect(audit(ctx, 'x', 'y', 'z')).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})

describe('audit — request audit scope', () => {
  it('a successful write counts as written in the scope', async () => {
    vi.mocked(getSession).mockReturnValue(fakeSession() as never)
    const counts = await runInAuditScope(async () => {
      await audit(ctx, 'a', 'b', 'c')
      return { written: auditsWrittenInScope(), failed: auditsFailedInScope() }
    })
    expect(counts).toEqual({ written: 1, failed: 0 })
  })

  it('a failed write is moved from written to failed, so the mutation registry writes the generic entry', async () => {
    vi.mocked(getSession).mockReturnValue(fakeSession(() => { throw new Error('boom') }) as never)
    const counts = await runInAuditScope(async () => {
      await audit(ctx, 'a', 'b', 'c')
      return { written: auditsWrittenInScope(), failed: auditsFailedInScope() }
    })
    expect(counts).toEqual({ written: 0, failed: 1 })
  })

  it('the write is noted synchronously, before any await (the registry reads it at resolver end)', async () => {
    vi.mocked(getSession).mockReturnValue(fakeSession() as never)
    await runInAuditScope(async () => {
      const pending = audit(ctx, 'a', 'b', 'c')
      expect(auditsWrittenInScope()).toBe(1)
      await pending
    })
  })
})
