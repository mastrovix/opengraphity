/**
 * portal.ts — createTicket, percorso valido: l'Incident è scritto con
 * tenant_id/created_by dal contesto e status iniziale del workflow, poi
 * workflowEngine.createInstance sul tenant e publishEvent. Categoria non
 * valida → ValidationError senza scrittura (la priorità non valida è già
 * coperta da portalReopen.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }), transition: vi.fn(), getAvailableTransitions: vi.fn() },
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn(), getInitialStepName: vi.fn().mockResolvedValue('new') }))

const { portalResolvers } = await import('../portal.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const { audit } = await import('../../../lib/audit.js')
const { getInitialStepName } = await import('../../../lib/workflowHelpers.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@test.io', role: 'end_user' }
const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

function enums(categories: string[], priorities: string[]) {
  mockSession.executeRead.mockReset()
  mockSession.executeRead
    .mockResolvedValueOnce({ records: [rec({ values: categories })] })
    .mockResolvedValueOnce({ records: [rec({ values: priorities })] })
}

const txRun = vi.fn()
function writeReturning(props: Record<string, unknown> | undefined) {
  txRun.mockResolvedValue({ records: props ? [rec({ props })] : [] })
  mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun }))
}

describe('createTicket — percorso valido', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    txRun.mockReset()
    enums(['hardware', 'software'], ['low', 'medium', 'high'])
  })

  it('CREATE Incident con tenant_id/created_by dal contesto e status iniziale del workflow; createInstance sul tenant; publishEvent; audit', async () => {
    writeReturning({ id: 'inc-1', title: 'Stampante rotta', description: null, status: 'new', priority: 'high', category: 'hardware', created_at: 'a', updated_at: 'a', created_by: 'user-1' })

    const out = await portalResolvers.Mutation.createTicket(null, { title: 'Stampante rotta', priority: 'high', category: 'hardware' }, ctx)

    // enum letti per il tenant del contesto
    expect(getInitialStepName).toHaveBeenCalledWith(mockSession, 'tenant-1', 'incident')
    const [cypher, params] = txRun.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('CREATE (i:Incident {')
    expect(cypher).toContain('tenant_id:   $tenantId')
    expect(cypher).toContain('created_by:  $userId')
    expect(params).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', title: 'Stampante rotta', description: null, priority: 'high', category: 'hardware', status: 'new' })
    expect(typeof params['id']).toBe('string')

    expect(workflowEngine.createInstance).toHaveBeenCalledWith(mockSession, 'tenant-1', params['id'], 'incident')
    expect(publishEvent).toHaveBeenCalledWith('portal.ticket.created', 'tenant-1', 'user-1', { ticketId: params['id'], title: 'Stampante rotta', category: 'hardware', priority: 'high', userId: 'user-1' }, params['now'])
    expect(audit).toHaveBeenCalledWith(ctx, 'portal.ticket.created', 'Incident', params['id'])
    expect(out).toMatchObject({ id: 'inc-1', type: 'incident', status: 'new', priority: 'high', category: 'hardware' })
  })

  it('categoria non valida → ValidationError, nessuna scrittura né workflow', async () => {
    const err = await portalResolvers.Mutation.createTicket(null, { title: 'T', priority: 'high', category: 'caffè' }, ctx).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toBe('Invalid category: caffè')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('titolo vuoto → ValidationError prima di leggere gli enum', async () => {
    await expect(portalResolvers.Mutation.createTicket(null, { title: '', priority: 'high', category: 'hardware' }, ctx)).rejects.toThrow(/title must be at least 1/)
    expect(mockSession.executeRead).not.toHaveBeenCalled()
  })

  it('createInstance fallisce → la mutation fallisce (nessun ticket "senza workflow" restituito), nessun evento pubblicato', async () => {
    writeReturning({ id: 'inc-1', title: 'T', status: 'new', priority: 'high', category: 'hardware', created_at: 'a', updated_at: 'a' })
    vi.mocked(workflowEngine.createInstance).mockRejectedValueOnce(new Error('No active workflow definition for "incident"'))
    await expect(portalResolvers.Mutation.createTicket(null, { title: 'T', priority: 'high', category: 'hardware' }, ctx)).rejects.toThrow(/No active workflow definition/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('comportamento REALE: enum priority/category non seedati per il tenant (set vuoto) → qualunque valore è accettato', async () => {
    enums([], [])
    writeReturning({ id: 'inc-1', title: 'T', status: 'new', priority: 'qualsiasi', category: 'boh', created_at: 'a', updated_at: 'a' })
    await expect(portalResolvers.Mutation.createTicket(null, { title: 'T', priority: 'qualsiasi', category: 'boh' }, ctx)).resolves.toMatchObject({ priority: 'qualsiasi' })
  })

  it.todo('enum priority/category assenti per il tenant → errore esplicito invece di accettare qualunque valore — GAP fail-fast (portal.ts:249-250: guardia `size > 0 &&`)')
})
