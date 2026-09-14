/**
 * portal.ts — createTicket (revisione del 14 set 2026 · IT-4, IT-7).
 *
 * Prima il portale scriveva l'incident con una Cypher sua: niente numero,
 * niente `incident.created` (nessuno SLA, nessuna regola di notifica, nessuna
 * automazione), priorità copiata senza matrice, e categoria/priorità validate
 * solo contro le copie del tenant — senza copia, passava qualunque valore.
 * Ora il ticket nasce da `incidentService.createIncident` con il canale
 * `portal`, e il portale non scrive nessun incident da sé.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { ValidationError } from '../../../lib/errors.js'

const created = { id: 'inc-1', number: 'INC00000042', severity: 'high', status: 'new' }
const props = { id: 'inc-1', number: 'INC00000001', title: 'Stampante rotta', description: null, status: 'new', severity: 'high', category: 'hardware', created_at: 'a', updated_at: 'a', created_by: 'user-1' }
const writes: string[] = []

const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async () => ({ records: [{ get: () => props }] }) })),
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async (c: string) => { writes.push(c); return { records: [] } } })),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0) }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en') }))
// Verifica «Cosa resta cablato», ondata 1: le severità offerte nel portale.
vi.mock('../../../lib/portalSeverityOptions.js', () => import('../../../lib/__tests__/portalSeverityOptionsFake.js'))
vi.mock('../../../lib/vocabularyEntries.js', () => ({ loadVocabularyEntries: vi.fn(async () => ({ values: ['low', 'medium', 'high', 'critical'], labels: {}, colors: {} })) }))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), getAvailableTransitions: vi.fn() } }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../../services/incidentService.js', () => ({ createIncident: vi.fn(async () => created) }))

const { portalResolvers } = await import('../portal.js')
const incidentService = await import('../../../services/incidentService.js')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const { audit } = await import('../../../lib/audit.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@test.io', role: 'end_user' }

beforeEach(() => { vi.clearAllMocks(); writes.length = 0 })

describe('createTicket', () => {
  it('nasce dal servizio con il canale portal: priorità nella severità, categoria, utente del contesto', async () => {
    const out = await portalResolvers.Mutation.createTicket(null, { title: 'Stampante rotta', priority: 'high', category: 'hardware' }, ctx)
    expect(incidentService.createIncident).toHaveBeenCalledWith(
      { title: 'Stampante rotta', description: undefined, severity: 'high', category: 'hardware' },
      { tenantId: 'tenant-1', userId: 'user-1' },
      'portal',
    )
    expect(writes).toHaveLength(0)
    expect(publishEvent).toHaveBeenCalledWith('portal.ticket.created', 'tenant-1', 'user-1', { ticketId: 'inc-1', title: 'Stampante rotta', category: 'hardware', priority: 'high', userId: 'user-1' }, 'a')
    expect(audit).toHaveBeenCalledWith(ctx, 'portal.ticket.created', 'Incident', 'inc-1')
    expect(out).toMatchObject({ id: 'inc-1', type: 'incident', status: 'new', priority: 'high', priorityLabel: 'High', category: 'hardware' })
  })

  it('un rifiuto del servizio (valore fuori Dizionario) ferma tutto: nessun evento del portale', async () => {
    vi.mocked(incidentService.createIncident).mockRejectedValueOnce(new ValidationError('category: "caffè" is not in the dictionary', { key: 'errors.vocabulary.outOfVocabulary' }))
    await expect(portalResolvers.Mutation.createTicket(null, { title: 'T', priority: 'high', category: 'caffè' }, ctx)).rejects.toThrow(/dictionary/)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  // Verifica «Cosa resta cablato», ondata 1: dal portale solo ciò che il portale offre.
  it('una severità del vocabolario che l\'amministratore NON offre nel portale → rifiutata prima del servizio', async () => {
    await expect(portalResolvers.Mutation.createTicket(null, { title: 'T', priority: 'critical', category: 'hardware' }, ctx))
      .rejects.toThrow(/"critical" is not one of the severities offered in the portal \(low, medium, high\)/)
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })

  it('titolo vuoto o priorità assente → ValidationError prima di chiamare il servizio', async () => {
    await expect(portalResolvers.Mutation.createTicket(null, { title: '', priority: 'high', category: 'hardware' }, ctx)).rejects.toThrow(/title must be at least 1/)
    await expect(portalResolvers.Mutation.createTicket(null, { title: 'T', category: 'hardware' }, ctx)).rejects.toThrow(/priority is required/)
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })
})
