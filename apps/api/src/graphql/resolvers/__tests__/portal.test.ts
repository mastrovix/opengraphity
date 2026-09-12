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
    registerCondition: vi.fn(),
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

/**
 * Ondata 7 · D-15: il portale espone `statusCategory`/`statusLabel` dal
 * workflow DEL CLIENTE, perché lo stile della pastiglia viene dalla categoria
 * del passo e non da una mappa di nomi di fabbrica. Qui il workflow del cliente
 * di prova ha un passo rinominato (`in_carico`) con categoria `active`.
 */
vi.mock('../../../lib/workflowHelpers.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/workflowHelpers.js')>()
  return {
    ...orig,
    getWorkflowSteps: vi.fn().mockResolvedValue([
      { name: 'new',       label: 'Nuovo',    isInitial: true,  isTerminal: false, isOpen: true,  category: 'active',   purpose: null, stepOrder: 1 },
      { name: 'in_carico', label: 'In carico', isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   purpose: null, stepOrder: 2 },
      { name: 'closed',    label: 'Chiuso',   isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',   purpose: null, stepOrder: 3 },
    ]),
  }
})

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
    // `open` non è un passo del workflow di questo cliente: categoria ed
    // etichetta sono `null`, non inventate (il portale mostra il valore grezzo
    // e lo stile neutro).
    expect(result).toMatchObject({ statusCategory: null, statusLabel: null })
  })

  /**
   * Ondata 7 · D-15: il passo RINOMINATO dal cliente porta la sua categoria e
   * la sua etichetta. Prima il portale non aveva né l'una né l'altra: coloriva
   * per nome di passo di fabbrica e mostrava il nome grezzo.
   */
  it('passo rinominato dal cliente → categoria ed etichetta del suo workflow', async () => {
    mockSession.executeRead.mockResolvedValueOnce({
      records: [makeRecord({
        props: {
          id: 'inc-2', title: 'Monitor', status: 'in_carico', priority: 'low',
          category: 'hardware', created_by: 'user-1',
          created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
        },
        assignedTeam: null,
      })],
    })
    const result = await myTicket(null, { id: 'inc-2' }, ctx)
    expect(result).toMatchObject({ status: 'in_carico', statusCategory: 'active', statusLabel: 'In carico' })
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

  /**
   * Ondata 2 → 8: il commento nasceva SENZA `entity_type`/`entity_id`, legato
   * all'incident solo dalla relazione `HAS_ENTITY_COMMENT`. Il lato operatore
   * legge per proprietà (`resolvers/comments.ts`,
   * `MATCH (c:EntityComment {tenant_id, entity_type, entity_id})`): quel
   * commento non compariva nel ticket, quindi il cliente scriveva e nessuno
   * leggeva. Il difetto l'ha trovato il lint `tenantOnCreate`.
   */
  it('il commento porta entity_type/entity_id, o non lo vede il lato operatore', async () => {
    mockSession.executeRead
      .mockResolvedValueOnce({ records: [makeRecord({ createdBy: 'user-1' })] })
      .mockResolvedValueOnce({ records: [makeRecord({ name: 'Mario Rossi', email: 'mario@test.io' })] })

    await addTicketComment(null, { ticketId: 'inc-42', body: 'ciao' }, ctx)

    const tx = { run: vi.fn() }
    await (mockSession.executeWrite.mock.calls[0]![0] as (t: typeof tx) => unknown)(tx)
    const [cypher, params] = tx.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain("entity_type:  'incident'")
    expect(cypher).toContain('entity_id:    $ticketId')
    expect(cypher).toContain('CREATE (i)-[:HAS_ENTITY_COMMENT]->(c)')
    expect(params['ticketId']).toBe('inc-42')
  })
})
