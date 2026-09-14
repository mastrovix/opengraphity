/**
 * Le azioni delle regole sui ticket fanno quello che fa una persona.
 * Giro del 14 set 2026: una regola «assegna team» lasciava l'incident in
 * «Nuovo» (a mano diventa «Assegnato»), e il suo commento risultava di
 * «Unknown user»; su un problem il commento non si vedeva affatto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})
const runQuery = vi.fn(async (..._a: unknown[]) => [{ ok: 1 }])
vi.mock('@opengraphity/neo4j', () => ({ runQuery: (...a: unknown[]) => runQuery(...a) }))
vi.mock('@opengraphity/events', () => ({ publish: vi.fn() }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({ withSession: vi.fn().mockImplementation((fn: (s: unknown) => unknown) => fn({})) }))
const assignIncidentToTeam = vi.fn(async () => ({}))
vi.mock('../../services/incidentService.js', () => ({ assignIncidentToTeam }))
const setTicketTeam = vi.fn(async () => ({ teamName: 'Rete' }))
vi.mock('../../services/ticketAssignment.js', () => ({ setTicketTeam }))

const { executeActions } = await import('../actionExecutor.js')
const ctx = (entityType: string) => ({ tenantId: 't1', userId: 'system', entityId: 'x-1', entityType, entity: { id: 'x-1' }, source: 'business_rule' as const, sourceName: 'Hardware al Service Desk' })

beforeEach(() => { vi.clearAllMocks() })

describe('assign_team', () => {
  it('su un incident passa dal servizio (workflow, nota, evento), non da una scrittura nuda', async () => {
    const r = await executeActions([{ type: 'assign_team', params: { team_id: 'sd' } }], ctx('incident'))
    expect(r[0]!.success).toBe(true)
    expect(assignIncidentToTeam).toHaveBeenCalledWith('x-1', 'sd', { tenantId: 't1', userId: 'system' })
    expect(runQuery).not.toHaveBeenCalled()
  })
  it('su un problem usa l\'assegnazione dei ticket', async () => {
    await executeActions([{ type: 'assign_team', params: { team_id: 'rete' } }], ctx('problem'))
    expect(setTicketTeam).toHaveBeenCalledWith({}, 'Problem', 'x-1', 'rete', 't1')
  })
})

describe('create_comment', () => {
  it('il commento porta il nome della regola e il nodo giusto per il tipo di ticket', async () => {
    await executeActions([{ type: 'create_comment', params: { text: 'Guasto hardware' } }], ctx('incident'))
    expect(String(runQuery.mock.calls[0]![1])).toMatch(/MATCH \(e:Incident[\s\S]*CREATE \(c:Comment/)
    expect(runQuery.mock.calls[0]![2]).toMatchObject({ authorLabel: 'Hardware al Service Desk', text: 'Guasto hardware' })
    runQuery.mockClear()
    await executeActions([{ type: 'create_comment', params: { text: 'Nota' } }], ctx('problem'))
    expect(String(runQuery.mock.calls[0]![1])).toMatch(/MATCH \(e:Problem[\s\S]*CREATE \(c:ProblemComment/)
  })
})
