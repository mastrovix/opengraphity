/**
 * Diagnostics for tickets whose step deadline could not move them, and that are
 * still sitting in that step. The deadline engine records the outcome on the
 * step execution; this read surfaces it with the ticket number so an admin
 * sees "INC00000012 is stuck, and why" instead of a ticket that silently never
 * escalates.
 *
 * Pinned: tenant scoping, only open executions with a refused/failed outcome,
 * and a readable row even when the reason or the ticket node is missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ runQuery: (...a: unknown[]) => runQuery(...a) }))

const { blockedStepDeadlines } = await import('../stepDeadlineBlocked.js')

const session = {} as Session

beforeEach(() => { runQuery.mockReset() })

describe('blockedStepDeadlines', () => {
  it('reads only the tenant, only steps still open whose deadline was refused or failed', async () => {
    runQuery.mockResolvedValue([])
    await blockedStepDeadlines(session, 'tenant-a')
    const [s, cypher, params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(s).toBe(session)
    expect(params).toEqual({ tenantId: 'tenant-a' })
    expect(cypher).toContain('WorkflowInstance {tenant_id: $tenantId}')
    // A step already left is history, not a blocked ticket.
    expect(cypher).toContain('ex.exited_at IS NULL')
    expect(cypher).toContain("ex.deadline_outcome IN ['refused', 'failed']")
  })

  it('maps rows to strings, and a missing reason becomes an empty string rather than "undefined"', async () => {
    runQuery.mockResolvedValue([
      { number: 'INC00000012', step: 'waiting_vendor', outcome: 'refused', reason: 'transition not allowed' },
      { number: 'CHG00000003', step: 'review', outcome: 'failed', reason: null },
      { number: 'wi-entity-7', step: 'triage', outcome: 'failed' },
    ])
    expect(await blockedStepDeadlines(session, 'tenant-a')).toEqual([
      { number: 'INC00000012', step: 'waiting_vendor', outcome: 'refused', reason: 'transition not allowed' },
      { number: 'CHG00000003', step: 'review', outcome: 'failed', reason: '' },
      { number: 'wi-entity-7', step: 'triage', outcome: 'failed', reason: '' },
    ])
  })
})
