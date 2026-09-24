/**
 * ticketAssignment — regola ITSM condivisa incident/problem: prima il gruppo,
 * poi un utente di quel gruppo. Neo4j mockato via runQueryOne di ci-utils.
 * Pinna: errori tipizzati (NotFoundError / ValidationError), query sempre
 * tenant-scoped, label interpolata solo dal tipo TicketLabel.
 *
 * Nota: non esiste alcuna logica round-robin / least-loaded in questo modulo
 * (l'assegnazione è sempre esplicita); "team senza membri" si manifesta come
 * ValidationError quando l'utente scelto non è MEMBER_OF del gruppo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('../../lib/db.js', () => ({ runQueryOne: vi.fn() }))

const { assertUserInAssignedTeam, setTicketTeam, setTicketUser } = await import('../ticketAssignment.js')
const { runQueryOne } = await import('../../lib/db.js')

const session = {} as Parameters<typeof runQueryOne>[0]

const lastQuery = () => {
  const call = vi.mocked(runQueryOne).mock.calls.at(-1)!
  return { cypher: call[1] as string, params: call[2] as Record<string, unknown> }
}

async function failure(promise: Promise<unknown>, code: 'NOT_FOUND' | 'BAD_USER_INPUT'): Promise<GraphQLError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  return err as GraphQLError
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('assertUserInAssignedTeam', () => {
  it('ticket inesistente nel tenant → NotFoundError con label ed id', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    const err = await failure(assertUserInAssignedTeam(session, 'Incident', 'inc-1', 'u-1', 't-1'), 'NOT_FOUND')
    expect(err.message).toBe('Incident inc-1 not found')
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (e:Incident {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('(:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)')
    expect(params).toEqual({ id: 'inc-1', userId: 'u-1', tenantId: 't-1' })
  })

  it('nessun gruppo assegnato → ValidationError "prima il gruppo" (messaggio per entità)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ teamId: null, teamName: null, isMember: false })
    const inc = await failure(assertUserInAssignedTeam(session, 'Incident', 'inc-1', 'u-1', 't-1'), 'BAD_USER_INPUT')
    expect(inc.message).toBe("Incident: assign a group first, then a user from that group")
    const prb = await failure(assertUserInAssignedTeam(session, 'Problem', 'prb-1', 'u-1', 't-1'), 'BAD_USER_INPUT')
    expect(prb.message).toBe('Problem: assign a group first, then a user from that group')
    expect(lastQuery().cypher).toContain('MATCH (e:Problem {id: $id, tenant_id: $tenantId})')
  })

  it('utente non membro del gruppo (anche gruppo senza membri) → ValidationError col nome del gruppo', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ teamId: 'team-1', teamName: 'NOC', isMember: false })
    const err = await failure(assertUserInAssignedTeam(session, 'Incident', 'inc-1', 'u-1', 't-1'), 'BAD_USER_INPUT')
    expect(err.message).toBe("The selected user does not belong to the assigned group (NOC)")

    vi.mocked(runQueryOne).mockResolvedValue({ teamId: 'team-1', teamName: null, isMember: false })
    const noName = await failure(assertUserInAssignedTeam(session, 'Incident', 'inc-1', 'u-1', 't-1'), 'BAD_USER_INPUT')
    expect(noName.message).toBe("The selected user does not belong to the assigned group")
  })

  it('utente membro → ritorna team id e nome', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ teamId: 'team-1', teamName: 'NOC', isMember: true })
    await expect(assertUserInAssignedTeam(session, 'Problem', 'prb-1', 'u-1', 't-1')).resolves.toEqual({ teamId: 'team-1', teamName: 'NOC' })
  })
})

describe('setTicketTeam', () => {
  it('ticket o team inesistenti nel tenant → NotFoundError', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    const err = await failure(setTicketTeam(session, 'Incident', 'inc-1', 'team-x', 't-1'), 'NOT_FOUND')
    expect(err.message).toBe('Incident o Team inc-1 / team-x not found')
  })

  it('sostituisce il gruppo (DELETE del vecchio, CREATE del nuovo), aggiorna updated_at, ritorna il nome', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ teamName: 'DBA' })
    await expect(setTicketTeam(session, 'Problem', 'prb-1', 'team-2', 't-1')).resolves.toEqual({ teamName: 'DBA', previousTeamName: null, unassignedUserName: null })
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (e:Problem {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('MATCH (t:Team {id: $teamId, tenant_id: $tenantId})')
    // Il frammento unico (lib/ticketTeamHistory.ts): sostituisce il team e scrive la storia delle assegnazioni.
    expect(cypher).toContain('DELETE __oldTeam')
    expect(cypher).toContain('CREATE (e)-[:ASSIGNED_TO_TEAM]->(t)')
    expect(cypher).toContain('TicketTeamSegment')
    expect(params['__teamNow']).toBe(params['now'])
    expect(cypher).toContain('SET e.updated_at = $now')
    expect(params).toMatchObject({ id: 'prb-1', teamId: 'team-2', tenantId: 't-1' })
    expect(params['now']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  /**
   * Revisione totale · M-10: la regola ITSM «prima il gruppo, poi una persona
   * di quel gruppo» (imposta da `assertUserInAssignedTeam`) veniva violata
   * subito dopo ogni cambio di gruppo: il ticket restava assegnato a qualcuno
   * che nel gruppo nuovo non c'è.
   */
  it('l\'assegnatario che non è nel gruppo nuovo viene staccato, e si dice chi era (M-10)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ teamName: 'DBA', unassignedUserName: 'Mario' })
    await expect(setTicketTeam(session, 'Incident', 'inc-1', 'team-2', 't-1'))
      .resolves.toEqual({ teamName: 'DBA', previousTeamName: null, unassignedUserName: 'Mario' })
    const { cypher } = lastQuery()
    expect(cypher).toContain('OPTIONAL MATCH (e)-[__assignee:ASSIGNED_TO]->(u:User)')
    expect(cypher).toContain('WHERE NOT exists((u)-[:MEMBER_OF]->(t))')
    expect(cypher).toContain('DELETE __assignee')
  })
})

describe('setTicketUser', () => {
  it('userId null → rimuove l\'assegnatario; ticket inesistente → NotFoundError', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ id: 'inc-1' })
    await expect(setTicketUser(session, 'Incident', 'inc-1', null, 't-1')).resolves.toEqual({ userName: null, previousUserName: null })
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->(__prima:User)')
    expect(cypher).toContain('DELETE old')
    expect(cypher).not.toContain('CREATE')
    expect(params).toMatchObject({ id: 'inc-1', tenantId: 't-1' })

    vi.mocked(runQueryOne).mockResolvedValue(null)
    const err = await failure(setTicketUser(session, 'Incident', 'inc-x', null, 't-1'), 'NOT_FOUND')
    expect(err.message).toBe('Incident inc-x not found')
  })

  it('userId valorizzato → sostituisce ASSIGNED_TO con l\'utente del tenant e ritorna il nome', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ userName: 'Mario' })
    await expect(setTicketUser(session, 'Problem', 'prb-1', 'u-1', 't-1')).resolves.toEqual({ userName: 'Mario', previousUserName: null })
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (e:Problem {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(cypher).toContain('CREATE (e)-[:ASSIGNED_TO]->(u)')
    expect(params).toMatchObject({ id: 'prb-1', userId: 'u-1', tenantId: 't-1' })
  })

  it('ticket o utente inesistenti nel tenant → NotFoundError', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    const err = await failure(setTicketUser(session, 'Problem', 'prb-1', 'u-x', 't-1'), 'NOT_FOUND')
    expect(err.message).toBe('Problem o User prb-1 / u-x not found')
  })
})
