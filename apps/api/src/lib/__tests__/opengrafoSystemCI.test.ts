/**
 * OPENGRAFO IS A CI OF EVERY TENANT (26 Sep 2026).
 *
 * What a user loses if this regresses: a remedy's Problem that reaches no one;
 * a migration run again that puts back the administrators someone removed
 * from the team, or moves the Owner Group someone changed; a CI status the
 * organization's Dictionary does not have; the product's CI deleted or
 * renamed from the CMDB.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ensureOpenGrafoSystemCI, openGrafoSystemCI, assertSystemCIChange, OPENGRAFO_CI_KEY, OPENGRAFO_ADMINS_TEAM_KEY } from '../opengrafoSystemCI.js'

interface Call { q: string; params: Record<string, unknown> }
let calls: Call[] = []
let state: { status: string | null; environment: string | null; ownerTypeKnown: boolean; teamExists: boolean; ciExists: boolean; admins: number }

const rec = (o: Record<string, unknown>) => ({ get: (k: string) => o[k] })
const session = {
  run: async (q: string, params: Record<string, unknown> = {}) => {
    calls.push({ q, params })
    if (q.includes("name: 'ci_status'")) return { records: [rec({ status: state.status, environment: state.environment, ownerTypeKnown: state.ownerTypeKnown })] }
    if (q.includes('MERGE (t:Team')) return { records: [rec({ id: 't-adm', missing: !state.teamExists })] }
    if (q.includes('MERGE (u)-[:MEMBER_OF]->(t)')) return { records: [rec({ n: state.admins })] }
    if (q.includes('MERGE (ci:ConfigurationItem')) return { records: [rec({ missing: !state.ciExists })] }
    return { records: [] }
  },
} as never

beforeEach(() => {
  calls = []
  state = { status: 'active', environment: null, ownerTypeKnown: true, teamExists: false, ciExists: false, admins: 21 }
})

describe('ensureOpenGrafoSystemCI', () => {
  it('a new tenant: the team is born with its administrators, the CI with the Dictionary\'s status, owned by the team', async () => {
    expect(await ensureOpenGrafoSystemCI(session, 't-a', 'NOW')).toEqual({ teamCreated: true, members: 21, ciCreated: true })
    const team = calls.find((c) => c.q.includes('MERGE (t:Team'))!
    expect(team.params).toMatchObject({ tenantId: 't-a', teamKey: OPENGRAFO_ADMINS_TEAM_KEY, teamName: 'OpenGrafo Administrators', teamType: 'owner' })
    expect(team.q).toContain('t.is_system = true')
    expect(calls.find((c) => c.q.includes('MEMBER_OF'))!.params).toMatchObject({ adminRole: 'admin' })
    const ci = calls.find((c) => c.q.includes('MERGE (ci:ConfigurationItem'))!
    expect(ci.params).toMatchObject({ ciKey: OPENGRAFO_CI_KEY, ciName: 'OpenGrafo', status: 'active', environment: null })
    expect(ci.q).toContain('ON CREATE SET ci:Platform')
    expect(ci.q).toContain("ci.chain = 'Infrastructure'")
    expect(ci.q).toContain('FOREACH (_ IN CASE WHEN missing THEN [1] ELSE [] END | MERGE (ci)-[:OWNED_BY]->(t))')
  })

  it('run again: nothing of what the organization changed is put back — no members added, no owner moved', async () => {
    state.teamExists = true
    state.ciExists = true
    expect(await ensureOpenGrafoSystemCI(session, 't-a', 'NOW')).toEqual({ teamCreated: false, members: 0, ciCreated: false })
    expect(calls.some((c) => c.q.includes('MERGE (u)-[:MEMBER_OF]->(t)'))).toBe(false)
  })

  it('a vocabulary without «owner»: the team is born with no type, not with a word the tenant does not have', async () => {
    state.ownerTypeKnown = false
    await ensureOpenGrafoSystemCI(session, 't-a', 'NOW')
    expect(calls.find((c) => c.q.includes('MERGE (t:Team'))!.params['teamType']).toBeNull()
  })

  it('an empty status Dictionary: said, nothing written', async () => {
    state.status = null
    await expect(ensureOpenGrafoSystemCI(session, 't-a', 'NOW')).rejects.toThrow(/"ci_status" Dictionary of tenant t-a is empty/)
    expect(calls).toHaveLength(1)
  })
})

describe('openGrafoSystemCI', () => {
  it('found by its key, with its owner and how many people the owner has', async () => {
    const s = { run: async () => ({ records: [rec({ ciId: 'ci-og', teamId: 't-adm', members: { toNumber: () => 3 } })] }) } as never
    expect(await openGrafoSystemCI(s, 't-a')).toEqual({ ciId: 'ci-og', ownerTeamId: 't-adm', ownerMembers: 3 })
    const none = { run: async () => ({ records: [] }) } as never
    expect(await openGrafoSystemCI(none, 't-a')).toBeNull()
  })
})

describe('assertSystemCIChange', () => {
  const og = { name: 'OpenGrafo', is_system: true }
  it('a system CI is not deleted nor renamed; the same name, or another field, passes', () => {
    expect(() => assertSystemCIChange(og, 'delete')).toThrow(/cannot be deleted/)
    expect(() => assertSystemCIChange(og, { name: 'X' })).toThrow(/cannot be renamed/)
    expect(() => assertSystemCIChange(og, { name: 'OpenGrafo' })).not.toThrow()
    expect(() => assertSystemCIChange(og, {})).not.toThrow()
  })
  it('any other CI is the organization\'s', () => {
    expect(() => assertSystemCIChange({ name: 'srv' }, 'delete')).not.toThrow()
    expect(() => assertSystemCIChange({ name: 'srv', is_system: false }, { name: 'X' })).not.toThrow()
  })
})
