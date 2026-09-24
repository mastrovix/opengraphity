/**
 * backfillChangeManagerApprovals (approvalCreation.ts).
 *
 * When an admin designates the first Change Manager team, changes already
 * parked in an approval step were built without a CM requirement: without the
 * backfill they would stay stuck forever (the gate refuses them) or, worse, a
 * partial gate could let them through. These tests pin that the backfill reads
 * only the tenant's stuck changes, excludes the tenant's pre-approved types
 * (data, not the literal `standard`), and rebuilds every requirement of each one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/db.js', () => ({
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))
let preApproved: string[] = ['standard']
vi.mock('../../../lib/changePolicy.js', () => ({
  isPreApprovedChangeType: (_t: string, type: unknown) => Promise.resolve(typeof type === 'string' && preApproved.includes(type)),
  preApprovedChangeTypes:  () => Promise.resolve(preApproved as readonly string[]),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

import { runQuery, runQueryOne } from '../../../lib/db.js'
import { backfillChangeManagerApprovals } from '../approvalCreation.js'
import { NotFoundError } from '../../../lib/errors.js'

const session = {} as Parameters<typeof runQuery>[0]
const many = vi.mocked(runQuery)
const one = vi.mocked(runQueryOne)

/** Changes stuck in approval, and the rebuild statements that were issued (change id per statement). */
let stuck: Array<{ id: string }> = []
let rebuilt: string[] = []

beforeEach(() => {
  preApproved = ['standard', 'routine']
  stuck = []
  rebuilt = []
  many.mockReset()
  one.mockReset()
  many.mockImplementation(async (_s, cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes("s.purpose = 'approval'")) return stuck as never
    if (cypher.includes('DETACH DELETE old')) rebuilt.push(String(params?.['changeId']))
    return [] as never
  })
  one.mockImplementation(async (_s, cypher: string) => {
    if (cypher.includes('RETURN c.change_type')) return { changeType: 'normal' } as never
    if (cypher.includes('is_change_manager: true')) return { id: 'team-cm' } as never
    return null as never
  })
})

describe('backfillChangeManagerApprovals', () => {
  it('rebuilds the requirements of every stuck change and returns how many', async () => {
    stuck = [{ id: 'chg-1' }, { id: 'chg-2' }]
    await expect(backfillChangeManagerApprovals(session, 't1', 'team-cm')).resolves.toBe(2)
    expect(rebuilt).toEqual(['chg-1', 'chg-2'])
  })

  it('looks only at the tenant and excludes the tenant\'s own pre-approved types', async () => {
    await backfillChangeManagerApprovals(session, 't1', 'team-cm')
    const [, cypher, params] = many.mock.calls.find(([, q]) => (q as string).includes("s.purpose = 'approval'"))!
    // A fresh array (the policy's list is readonly and cached): the tenant's own types, not the literal `standard`.
    expect(params).toEqual({ tenantId: 't1', preApproved: ['standard', 'routine'] })
    // Only changes that do NOT already have a CM requirement are touched: re-running is harmless.
    expect(cypher).toContain("NOT EXISTS { (c)-[:HAS_APPROVAL]->(:ChangeApproval {kind: 'change_manager'}) }")
  })

  it('with nothing stuck it changes nothing and returns 0', async () => {
    await expect(backfillChangeManagerApprovals(session, 't1', 'team-cm')).resolves.toBe(0)
    expect(rebuilt).toEqual([])
  })

  it('a stuck change that vanished mid-backfill stops it loudly instead of skipping it', async () => {
    stuck = [{ id: 'chg-gone' }]
    one.mockImplementation(async () => null as never)
    await expect(backfillChangeManagerApprovals(session, 't1', 'team-cm')).rejects.toBeInstanceOf(NotFoundError)
    expect(rebuilt).toEqual([])
  })
})
