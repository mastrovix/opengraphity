/**
 * THE TEAM OF A SERVICE REQUEST (D56, the owner's choice of 23 Sep 2026).
 *
 * A request had an assignee and no team, so the OLA/UC contracts on requests
 * measured nothing. The service writes the team through `setTicketTeam` (the
 * segment the OLA engine measures), leaves a note that says why — the
 * fulfilment group of the item, or a person's choice — and publishes
 * `ticket.team_assigned` so the SLA can follow the team.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ session: {}, completed: null as string | null, exists: true }))

vi.mock('@opengraphity/neo4j', () => ({
  runQueryOne: vi.fn(async (_s: unknown, cypher: string) => {
    if (cypher.includes('RETURN r.completed_at AS completedAt')) return h.exists ? { completedAt: h.completed } : null
    if (cypher.includes('RETURN properties(r) AS props')) return { props: { id: 'sr-1', number: 'REQ1' } }
    if (cypher.includes('FULFILLED_BY')) return { teamId: 'team-ful', itemName: 'New laptop' }
    return null
  }),
}))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn(h.session)) }))
vi.mock('../ticketAssignment.js', () => ({ setTicketTeam: vi.fn() }))
vi.mock('../requestService.js', () => ({ mapRequest: (p: Record<string, unknown>) => p }))
vi.mock('../../lib/ticketComments.js', () => ({ writeTicketComment: vi.fn() }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../lib/systemText.js', () => ({
  systemText: vi.fn(async (_t: string, key: string, params: Record<string, unknown> = {}) => `${key}|${JSON.stringify(params)}`),
}))

const { assignRequestToTeam, fulfilmentTeamOf } = await import('../requestAssignment.js')
const { setTicketTeam } = await import('../ticketAssignment.js')
const { writeTicketComment } = await import('../../lib/ticketComments.js')
const { publishEvent } = await import('../../lib/publishEvent.js')

const ctx = { tenantId: 't-1', userId: 'u-1' }
const notes = () => vi.mocked(writeTicketComment).mock.calls.map(([, c]) => (c as { text: string }).text)

beforeEach(() => {
  vi.clearAllMocks()
  h.completed = null
  h.exists = true
  vi.mocked(setTicketTeam).mockResolvedValue({ teamName: 'Desk', previousTeamName: null, unassignedUserName: null })
})

describe('assignRequestToTeam', () => {
  it('from the catalog: the fulfilment group, a note that names the item, and the event the SLA listens to', async () => {
    const out = await assignRequestToTeam('sr-1', 'team-ful', ctx, { fromCatalogItem: 'New laptop' })
    expect(setTicketTeam).toHaveBeenCalledWith(h.session, 'ServiceRequest', 'sr-1', 'team-ful', 't-1')
    expect(notes()).toEqual(['request.fulfilmentTeam|{"team":"Desk","item":"New laptop"}'])
    expect(vi.mocked(writeTicketComment).mock.calls[0]![1]).toMatchObject({ entityType: 'service_request', entityId: 'sr-1', isInternal: true, authorId: 'u-1' })
    expect(publishEvent).toHaveBeenCalledWith('ticket.team_assigned', 't-1', 'u-1', { entity_type: 'service_request', entity_id: 'sr-1', team_id: 'team-ful' }, expect.any(String))
    expect(out).toMatchObject({ teamName: 'Desk', previousTeamName: null, request: { id: 'sr-1' } })
  })

  it('by a person: «assigned» the first time, «reassigned» after, and the detached assignee is said', async () => {
    await assignRequestToTeam('sr-1', 'team-2', ctx)
    expect(notes()).toEqual(['request.assignedTeam|{"team":"Desk"}'])
    vi.clearAllMocks()
    vi.mocked(setTicketTeam).mockResolvedValue({ teamName: 'Network', previousTeamName: 'Desk', unassignedUserName: 'Ada' })
    await assignRequestToTeam('sr-1', 'team-3', ctx)
    expect(notes()).toEqual([
      'incident.unassignedOnTeamChange|{"user":"Ada","team":"Network"}',
      'request.reassignedTeam|{"team":"Network"}',
    ])
  })

  it('a concluded request, an unknown one and a missing team are refused before anything is written', async () => {
    h.completed = '2026-09-20T10:00:00Z'
    await expect(assignRequestToTeam('sr-1', 'team-2', ctx)).rejects.toThrow('A concluded request cannot be reassigned')
    h.completed = null
    h.exists = false
    await expect(assignRequestToTeam('sr-x', 'team-2', ctx)).rejects.toThrow(/not found/i)
    await expect(assignRequestToTeam('sr-1', ' ', ctx)).rejects.toThrow('teamId is required')
    expect(setTicketTeam).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

describe('fulfilmentTeamOf', () => {
  it('reads the FULFILLED_BY team of the item in the tenant', async () => {
    const { runQueryOne } = await import('@opengraphity/neo4j')
    await expect(fulfilmentTeamOf('t-1', 'item-1')).resolves.toEqual({ teamId: 'team-ful', itemName: 'New laptop' })
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls.at(-1)!
    expect(cypher).toContain('(i:ServiceCatalogItem {id: $catalogItemId, tenant_id: $tenantId})-[:FULFILLED_BY]->(t:Team {tenant_id: $tenantId})')
    expect(params).toEqual({ catalogItemId: 'item-1', tenantId: 't-1' })
  })
})
