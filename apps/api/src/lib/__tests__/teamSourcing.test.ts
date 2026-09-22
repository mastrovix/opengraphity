/**
 * lib/teamSourcing.ts — is a team internal or external?
 *
 * The distinction is what separates an OLA (internal team) from an UC (external
 * supplier contract). If the guard accepted anything, a typo like "extrnal"
 * would silently put a supplier under OLA reporting; if the diagnostic query
 * lost its tenant scope, one customer would see another customer's team names
 * in the configuration check.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Session } from 'neo4j-driver'

const { TEAM_SOURCINGS, isTeamSourcing, assertTeamSourcing, teamsWithoutSourcing } = await import('../teamSourcing.js')
const { ValidationError } = await import('../errors.js')

/** A session whose read transaction returns the given records and records the query it ran. */
function fakeSession(records: Array<Record<string, unknown>>) {
  const run = vi.fn(async () => ({ records: records.map((r) => ({ get: (k: string) => r[k] })) }))
  const session = { executeRead: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ run })) }
  return { session: session as unknown as Session, run }
}

describe('isTeamSourcing / assertTeamSourcing', () => {
  it('accepts exactly the two values, nothing else', () => {
    expect(TEAM_SOURCINGS).toEqual(['internal', 'external'])
    expect(isTeamSourcing('internal')).toBe(true)
    expect(isTeamSourcing('external')).toBe(true)
    expect(isTeamSourcing('External')).toBe(false)
    expect(isTeamSourcing('partner')).toBe(false)
    expect(isTeamSourcing(null)).toBe(false)
    expect(isTeamSourcing(1)).toBe(false)
  })

  it('returns the value when valid', () => {
    expect(assertTeamSourcing('external')).toBe('external')
  })

  it('refuses a missing value: there is no default, a new team must say it', () => {
    const err = (() => { try { assertTeamSourcing(undefined); return null } catch (e) { return e } })()
    expect(err).toBeInstanceOf(ValidationError)
    // undefined is reported as null, so the message stays valid JSON-ish text
    expect((err as Error).message).toContain('got null')
    expect((err as ValidationError).extensions['i18n']).toEqual({
      key: 'errors.team.sourcingRequired', params: { allowed: 'internal, external' },
    })
  })

  it('refuses an unknown value and names it in the message', () => {
    expect(() => assertTeamSourcing('partner')).toThrow(/got "partner", allowed internal, external/)
  })
})

describe('teamsWithoutSourcing', () => {
  it('queries only the given tenant, with the allowed values and the limit', async () => {
    const { session, run } = fakeSession([{ count: 2, names: ['Alpha', 'Beta'] }])
    expect(await teamsWithoutSourcing(session, 't1', 5)).toEqual({ count: 2, names: ['Alpha', 'Beta'] })
    const [cypher, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(cypher).toContain('Team {tenant_id: $tenantId}')
    expect(params).toEqual({ tenantId: 't1', valori: ['internal', 'external'], limit: 5 })
  })

  it('uses a limit of 10 by default', async () => {
    const { session, run } = fakeSession([{ count: 0, names: [] }])
    await teamsWithoutSourcing(session, 't1')
    expect((run.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['limit']).toBe(10)
  })

  it('converts a Neo4j Integer count to a plain number', async () => {
    // The driver returns Integer objects, not numbers: the diagnostic must print "3", not "[object Object]".
    const { session } = fakeSession([{ count: { toNumber: () => 3 }, names: ['A', 'B', 'C'] }])
    expect(await teamsWithoutSourcing(session, 't1')).toEqual({ count: 3, names: ['A', 'B', 'C'] })
  })

  it('treats a null names list as empty', async () => {
    const { session } = fakeSession([{ count: 0, names: null }])
    expect(await teamsWithoutSourcing(session, 't1')).toEqual({ count: 0, names: [] })
  })

  it('returns zero when the query yields no record', async () => {
    const { session } = fakeSession([])
    expect(await teamsWithoutSourcing(session, 't1')).toEqual({ count: 0, names: [] })
  })
})
