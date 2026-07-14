import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
}))

vi.mock('../../../lib/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../lib/publishEvent.js', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { portalResolvers } = await import('../portal.js')

const myTicket         = portalResolvers.Query.myTicket
const addTicketComment = portalResolvers.Mutation.addTicketComment

// ── Test context ──────────────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@test.io', role: 'end_user' }

const makeRecord = (map: Record<string, unknown>) => ({
  get: (key: string) => (key in map ? map[key] : null),
})

const expectForbidden = async (promise: Promise<unknown>, message: string) => {
  const error = await promise.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(GraphQLError)
  expect((error as GraphQLError).message).toBe(message)
  expect((error as GraphQLError).extensions['code']).toBe('FORBIDDEN')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('myTicket — ownership check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.executeRead.mockResolvedValue({ records: [] })
    mockSession.executeWrite.mockResolvedValue({ records: [] })
  })

  it('ticket inesistente → ForbiddenError "Ticket not found"', async () => {
    mockSession.executeRead.mockResolvedValueOnce({ records: [] })

    await expectForbidden(myTicket(null, { id: 'inc-x' }, ctx), 'Ticket not found')
  })

  it('utente che non è created_by → "Access denied" e nessun dato caricato', async () => {
    mockSession.executeRead.mockResolvedValueOnce({
      records: [makeRecord({
        props:        { id: 'inc-1', title: 'Altrui', status: 'open', created_by: 'other-user' },
        assignedTeam: null,
      })],
    })

    await expectForbidden(myTicket(null, { id: 'inc-1' }, ctx), 'Access denied')

    // Il check di ownership blocca prima di caricare commenti/allegati/storia
    expect(mockSession.executeRead).toHaveBeenCalledOnce()
  })

  it('owner → ritorna il ticket con commenti, allegati e storia', async () => {
    mockSession.executeRead.mockResolvedValueOnce({
      records: [makeRecord({
        props: {
          id: 'inc-1', title: 'Stampante rotta', status: 'open', priority: 'high',
          category: 'hardware', created_by: 'user-1',
          created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
        },
        assignedTeam: 'Service Desk',
      })],
    })
    // commenti, allegati, storia → default { records: [] }

    const result = await myTicket(null, { id: 'inc-1' }, ctx)

    expect(result).toMatchObject({
      id:           'inc-1',
      title:        'Stampante rotta',
      status:       'open',
      priority:     'high',
      assignedTeam: 'Service Desk',
      comments:     [],
      attachments:  [],
      history:      [],
    })
    // 1 ticket + 1 commenti + 1 allegati + 1 storia
    expect(mockSession.executeRead).toHaveBeenCalledTimes(4)
  })
})

describe('addTicketComment — ownership check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.executeRead.mockResolvedValue({ records: [] })
    mockSession.executeWrite.mockResolvedValue({ records: [] })
  })

  it('utente che non è created_by → "Access denied" e nessuna scrittura', async () => {
    mockSession.executeRead.mockResolvedValueOnce({
      records: [makeRecord({ createdBy: 'other-user' })],
    })

    await expectForbidden(
      addTicketComment(null, { ticketId: 'inc-1', body: 'ciao' }, ctx),
      'Access denied',
    )
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('owner → crea il commento pubblico con i dati autore', async () => {
    mockSession.executeRead
      .mockResolvedValueOnce({ records: [makeRecord({ createdBy: 'user-1' })] })
      .mockResolvedValueOnce({ records: [makeRecord({ name: 'Mario Rossi', email: 'mario@test.io' })] })

    const result = await addTicketComment(null, { ticketId: 'inc-1', body: 'un aggiornamento?' }, ctx)

    expect(mockSession.executeWrite).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      body:        'un aggiornamento?',
      isInternal:  false,
      authorId:    'user-1',
      authorName:  'Mario Rossi',
      authorEmail: 'mario@test.io',
    })
  })
})
