/**
 * team.ts — assignCIOwner / assignCISupportGroup: relazione single-valued
 * CI→Team; teamId null rimuove (DELETE senza MERGE), teamId valido sostituisce;
 * team/CI fuori tenant → NotFound; ruoli non ammessi → Forbidden (policy).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = {
  executeRead:  vi.fn(),
  executeWrite: vi.fn(),
  close:        vi.fn().mockResolvedValue(undefined),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../ci-utils.js')>()
  return {
    ...orig,
    withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  }
})
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))

const { teamResolvers } = await import('../team.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { withSession } = await import('../ci-utils.js')
const { authorize, allowedRoles } = await import('../../../lib/authorization.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator' }

const CI_ROW = { props: { id: 'ci-1', name: 'srv-01', status: 'active', created_at: '2026-01-01T00:00:00Z' }, label: 'Server' }

function lastQuery(): { cypher: string; params: Record<string, unknown> } {
  const call = vi.mocked(runQuery).mock.calls.at(-1)!
  return { cypher: call[1] as string, params: call[2] as Record<string, unknown> }
}

describe('assignCIOwner — relazione OWNED_BY single-valued', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([CI_ROW] as never)
  })

  it('teamId null → rimuove la relazione: DELETE senza MERGE, nessun MATCH sul Team', async () => {
    const out = await teamResolvers.Mutation.assignCIOwner(null, { ciId: 'ci-1', teamId: null }, ctx)

    expect(runQuery).toHaveBeenCalledOnce()
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('OPTIONAL MATCH (ci)-[old:OWNED_BY]->(:Team)')
    expect(cypher).toContain('DELETE old')
    expect(cypher).not.toContain('MERGE')
    expect(cypher).not.toContain('MATCH (t:Team')
    expect(cypher).toContain('MATCH (ci {id: $ciId, tenant_id: $tenantId})')
    // A-9: le etichette dei CI vengono dal metamodello del tenant, quindi un CI
    // di un tipo creato dal cliente si trova (prima: «ConfigurationItem or Team»).
    expect(cypher).toContain('ci:LoadBalancer')
    expect(params).toEqual({ ciId: 'ci-1', teamId: null, tenantId: 'tenant-1' })
    // sessione di scrittura
    expect(vi.mocked(withSession).mock.calls[0]![1]).toBe(true)
    expect(out).toMatchObject({ id: 'ci-1', name: 'srv-01', type: 'server' })
  })

  it('teamId omesso equivale a null (rimozione)', async () => {
    await teamResolvers.Mutation.assignCIOwner(null, { ciId: 'ci-1' }, ctx)
    const { cypher, params } = lastQuery()
    expect(cypher).not.toContain('MERGE')
    expect(params['teamId']).toBeNull()
  })

  it('teamId valido → cancella la relazione esistente e crea la nuova (DELETE old + MERGE), Team scoped per tenant', async () => {
    const out = await teamResolvers.Mutation.assignCIOwner(null, { ciId: 'ci-1', teamId: 'team-9' }, ctx)

    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (t:Team {id: $teamId, tenant_id: $tenantId})')
    expect(cypher).toContain('OPTIONAL MATCH (ci)-[old:OWNED_BY]->(:Team)')
    expect(cypher).toContain('DELETE old')
    expect(cypher).toContain('MERGE (ci)-[:OWNED_BY]->(t)')
    // il DELETE precede il MERGE: la relazione resta single-valued
    expect(cypher.indexOf('DELETE old')).toBeLessThan(cypher.indexOf('MERGE (ci)-[:OWNED_BY]->(t)'))
    expect(params).toEqual({ ciId: 'ci-1', teamId: 'team-9', tenantId: 'tenant-1' })
    expect(out).toMatchObject({ id: 'ci-1', type: 'server' })
  })

  it('team di un altro tenant (nessuna riga) → NotFoundError "ConfigurationItem or Team not found"', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)

    const err = await teamResolvers.Mutation.assignCIOwner(null, { ciId: 'ci-1', teamId: 'team-altro-tenant' }, ctx)
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
    expect((err as GraphQLError).message).toBe('ConfigurationItem or Team not found')
    // la query è comunque scoped: nessun parametro consente di uscire dal tenant
    expect(lastQuery().params['tenantId']).toBe('tenant-1')
  })

  it('CI di un altro tenant con teamId null → NotFoundError (la rimozione non è un no-op silenzioso)', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    await expect(teamResolvers.Mutation.assignCIOwner(null, { ciId: 'ci-altrui', teamId: null }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('assignCISupportGroup — stessa semantica su SUPPORTED_BY', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([CI_ROW] as never)
  })

  it('teamId null → DELETE su SUPPORTED_BY senza MERGE', async () => {
    await teamResolvers.Mutation.assignCISupportGroup(null, { ciId: 'ci-1', teamId: null }, ctx)
    const { cypher } = lastQuery()
    expect(cypher).toContain('[old:SUPPORTED_BY]')
    expect(cypher).not.toContain('OWNED_BY')
    expect(cypher).not.toContain('MERGE')
  })

  it('teamId valido → MERGE su SUPPORTED_BY', async () => {
    await teamResolvers.Mutation.assignCISupportGroup(null, { ciId: 'ci-1', teamId: 'team-2' }, ctx)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MERGE (ci)-[:SUPPORTED_BY]->(t)')
    expect(params['teamId']).toBe('team-2')
  })
})

describe('policy di ruolo sui campi root del team resolver', () => {
  it('assignCIOwner / assignCISupportGroup: admin e operator sì, viewer e end_user → Forbidden', () => {
    for (const field of ['assignCIOwner', 'assignCISupportGroup']) {
      expect(allowedRoles('Mutation', field)).toEqual(['admin', 'operator'])
      expect(() => authorize('Mutation', field, 'admin')).not.toThrow()
      expect(() => authorize('Mutation', field, 'operator')).not.toThrow()
      for (const role of ['viewer', 'end_user']) {
        const err = (() => { try { authorize('Mutation', field, role); return null } catch (e) { return e as GraphQLError } })()
        expect(err?.extensions['code']).toBe('FORBIDDEN')
      }
    }
  })

  it('createTeam / setTeamManager / removeTeamManager / setChangeManagerTeam: solo admin', () => {
    for (const field of ['createTeam', 'setTeamManager', 'removeTeamManager', 'setChangeManagerTeam']) {
      expect(allowedRoles('Mutation', field)).toEqual(['admin'])
      expect(() => authorize('Mutation', field, 'operator')).toThrow(GraphQLError)
    }
  })

  it('ruolo sconosciuto → Forbidden esplicito, nessun downgrade a viewer', () => {
    expect(() => authorize('Mutation', 'assignCIOwner', 'superuser')).toThrow(/Ruolo sconosciuto/)
  })
})

describe('team / setTeamManager — scoping per tenant', () => {
  beforeEach(() => vi.clearAllMocks())

  it('team(id) di un altro tenant → null (query con tenant_id)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    const out = await teamResolvers.Query.team(null, { id: 'team-x' }, ctx)
    expect(out).toBeNull()
    const call = vi.mocked(runQueryOne).mock.calls[0]!
    expect(call[1]).toContain('MATCH (t:Team {id: $id, tenant_id: $tenantId})')
    expect(call[2]).toEqual({ id: 'team-x', tenantId: 'tenant-1' })
  })

  it('setTeamManager con utente/team fuori tenant → NotFoundError, dopo aver rimosso il vecchio manager', async () => {
    mockSession.executeWrite.mockResolvedValue({ records: [] })
    vi.mocked(runQueryOne).mockResolvedValue(null as never)

    await expect(teamResolvers.Mutation.setTeamManager(null, { teamId: 'team-1', userId: 'user-altrui' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' }, message: 'Team or User not found' })
    const call = vi.mocked(runQueryOne).mock.calls[0]!
    expect(call[1]).toContain('MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(call[2]).toEqual({ teamId: 'team-1', userId: 'user-altrui', tenantId: 'tenant-1' })
  })
})
