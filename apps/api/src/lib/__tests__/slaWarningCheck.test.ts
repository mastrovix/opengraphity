/**
 * Diagnostics for SLA policies whose warning does not fall before the deadline.
 *
 * A migration once set a 30-minute warning on EVERY policy, including those
 * with a 30-minute resolution time: the "SLA about to be breached" alert fired
 * the moment each ticket was created. The resolver now refuses such values on
 * write; this read names the policies already stored that way, so an admin can
 * fix them. If it regresses, the diagnostics go silent while the alert keeps
 * spamming, or it reports another tenant's policies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'
import neo4j from 'neo4j-driver'

const runQuery = vi.fn()
// Never the real package: importing it opens a driver to a real database.
// `toNumber` is re-implemented just enough for the shapes Neo4j returns.
vi.mock('@opengraphity/neo4j', async () => {
  const { isInt } = await import('neo4j-driver')
  return {
    runQuery: (...a: unknown[]) => runQuery(...a),
    toNumber: (v: unknown) => (isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v)),
  }
})

const { slaPoliciesWarningNotBeforeDeadline } = await import('../slaWarningCheck.js')

const session = {} as Session

beforeEach(() => { runQuery.mockReset() })

describe('slaPoliciesWarningNotBeforeDeadline', () => {
  it('is tenant-scoped and only selects enabled policies whose warning is not before the deadline', async () => {
    runQuery.mockResolvedValue([])
    await slaPoliciesWarningNotBeforeDeadline(session, 'tenant-a')
    const [s, cypher, params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(s).toBe(session)
    expect(params).toEqual({ tenantId: 'tenant-a' })
    expect(cypher).toContain('SLAPolicyNode {tenant_id: $tenantId}')
    // A disabled policy never alerts, so it is not a problem to report.
    expect(cypher).toContain('coalesce(p.enabled, true)')
    // ">=": a warning exactly AT the deadline is as useless as one after it.
    expect(cypher).toContain('p.warning_minutes >= p.resolve_minutes')
  })

  it('converts Neo4j integers to plain numbers so the diagnostics can print them', async () => {
    runQuery.mockResolvedValue([
      { name: 'P1 - 30 min', warning: neo4j.int(30), resolve: neo4j.int(30) },
      { name: 'Legacy', warning: 45, resolve: '40' },
    ])
    expect(await slaPoliciesWarningNotBeforeDeadline(session, 'tenant-a')).toEqual([
      { name: 'P1 - 30 min', warningMinutes: 30, resolveMinutes: 30 },
      { name: 'Legacy', warningMinutes: 45, resolveMinutes: 40 },
    ])
  })

  it('no misconfigured policy gives an empty list', async () => {
    runQuery.mockResolvedValue([])
    expect(await slaPoliciesWarningNotBeforeDeadline(session, 'tenant-a')).toEqual([])
  })
})
