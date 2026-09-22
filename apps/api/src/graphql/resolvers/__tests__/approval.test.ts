/**
 * LE APPROVAZIONI (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/approval.ts` stava al 1,2%: due istruzioni su centosessantaquattro.
 * È il codice che decide se una richiesta è soddisfatta, chi può firmarla, e
 * — per un articolo della base di conoscenza — se l'approvazione lo PUBBLICA.
 * Il varco delle approvazioni nel workflow ha i suoi test (`approvalGate`,
 * `approvalRouting`); questo file, che è dove si firma, no.
 *
 * ## Quello che si verifica
 * Le quattro porte di `approveRequest` (non esiste, non è più pendente, non
 * sei fra i firmatari, hai già firmato), il conteggio per `any`/`all`/
 * `majority`, e il pezzo che è costato un difetto: l'articolo approvato va nel
 * passo di CATEGORIA `published`, non nella «prima transizione manuale in
 * avanti» — che in un workflow del cliente poteva essere «archivia».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const read = vi.fn()
const write = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: read }),
    executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: write }),
    close,
  })),
}))

const getAvailableTransitions = vi.fn()
const transition = vi.fn()
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    getAvailableTransitions: (...a: unknown[]) => getAvailableTransitions(...a),
    transition: (...a: unknown[]) => transition(...a),
  },
}))

const sendToUser = vi.fn()
vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: (...a: unknown[]) => sendToUser(...a) } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/systemText.js', () => ({ systemText: vi.fn(async (_t: string, k: string) => `testo:${k}`) }))
vi.mock('../pendingTicketApprovals.js', () => ({ pendingTicketApprovals: vi.fn() }))

const getWorkflowSteps = vi.fn()
vi.mock('../../../lib/workflowHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkflowSteps: (...a: unknown[]) => getWorkflowSteps(...a),
}))

const { approveRequest, rejectRequest, cancelApprovalRequest, createApprovalRequest, approvalRequests } =
  await import('../approval.js')

// ── aiuti ─────────────────────────────────────────────────────────────────────
const ctx = (userId = 'u1', role = 'operator') => ({
  tenantId: 't1', userId, userEmail: 'u@x', role, permissions: perms(role),
}) as never

/** Un `Record` di neo4j finto: `get(chiave)`. */
const rec = (campi: Record<string, unknown>) => ({ get: (k: string) => campi[k] ?? null })

/** La riga che le SET restituiscono: tutte le colonne del nodo. */
const rigaAggiornata = (over: Record<string, unknown> = {}) => rec({
  id: 'a1', tenantId: 't1', entityType: 'change', entityId: 'c1', title: 'T', description: null,
  status: 'pending', requestedBy: 'u9', requestedAt: 'ieri', approvers: '["u1","u2","u3"]',
  approvedBy: '["u1"]', rejectedBy: null, approvalType: 'any', dueDate: null,
  resolvedAt: null, resolutionNote: null, ...over,
})

/** Lo stato di partenza che `approveRequest` legge. */
function statoDiPartenza(over: Record<string, unknown> = {}) {
  read.mockResolvedValueOnce({ records: [rec({
    id: 'a1', status: 'pending', approvers: '["u1","u2","u3"]', approvedBy: '[]',
    approvalType: 'any', requestedBy: 'u9', entityType: 'change', entityId: 'c1', ...over,
  })] })
}

async function codice(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  read.mockResolvedValue({ records: [] })
  write.mockResolvedValue({ records: [rigaAggiornata()] })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('approveRequest — le quattro porte', () => {
  it('una richiesta che non esiste', async () => {
    expect((await codice(() => approveRequest(null, { id: 'a9' }, ctx()))).code).toBe('NOT_FOUND')
  })

  it('una già decisa non si firma una seconda volta', async () => {
    statoDiPartenza({ status: 'approved' })
    const r = await codice(() => approveRequest(null, { id: 'a1' }, ctx()))
    expect(r.code).toBe('BAD_REQUEST')
    expect(r.message).toContain("status 'approved'")
  })

  it('chi non è fra i firmatari non firma', async () => {
    statoDiPartenza({ approvers: '["u2"]' })
    expect((await codice(() => approveRequest(null, { id: 'a1' }, ctx('u1')))).code).toBe('FORBIDDEN')
  })

  it('e non si firma due volte', async () => {
    statoDiPartenza({ approvedBy: '["u1"]' })
    const r = await codice(() => approveRequest(null, { id: 'a1' }, ctx('u1')))
    expect(r.message).toContain('already approved')
  })

  it('nessuna scrittura quando una porta si chiude', async () => {
    statoDiPartenza({ status: 'cancelled' })
    await codice(() => approveRequest(null, { id: 'a1' }, ctx()))
    expect(write).not.toHaveBeenCalled()
  })
})

describe('approveRequest — quando la richiesta è soddisfatta', () => {
  /** Firma e restituisce lo stato scritto sul nodo. */
  async function firma(over: Record<string, unknown>, chi = 'u1') {
    statoDiPartenza(over)
    await approveRequest(null, { id: 'a1', note: 'ok' }, ctx(chi))
    return write.mock.calls[0]![1] as Record<string, unknown>
  }

  it('`any`: basta una firma', async () => {
    expect(await firma({ approvalType: 'any', approvers: '["u1","u2"]', approvedBy: '[]' }))
      .toMatchObject({ status: 'approved' })
  })

  it('`all`: finché ne manca uno resta pendente', async () => {
    expect(await firma({ approvalType: 'all', approvers: '["u1","u2","u3"]', approvedBy: '[]' }))
      .toMatchObject({ status: 'pending', resolvedAt: null })
    write.mockClear()
    expect(await firma({ approvalType: 'all', approvers: '["u1","u2"]', approvedBy: '["u2"]' }))
      .toMatchObject({ status: 'approved' })
  })

  it('`majority`: la metà non basta, serve PIÙ della metà', async () => {
    // due su quattro = metà → ancora pendente
    expect(await firma({ approvalType: 'majority', approvers: '["u1","u2","u3","u4"]', approvedBy: '["u2"]' }))
      .toMatchObject({ status: 'pending' })
    write.mockClear()
    // due su tre = più della metà
    expect(await firma({ approvalType: 'majority', approvers: '["u1","u2","u3"]', approvedBy: '["u2"]' }))
      .toMatchObject({ status: 'approved' })
  })

  it('un tipo di approvazione sconosciuto NON soddisfa: non si inventa un sì', async () => {
    expect(await firma({ approvalType: 'a-piacere', approvers: '["u1"]', approvedBy: '[]' }))
      .toMatchObject({ status: 'pending' })
  })

  it('la firma si aggiunge a quelle di prima, non le sostituisce', async () => {
    const p = await firma({ approvalType: 'all', approvers: '["u1","u2","u3"]', approvedBy: '["u2"]' })
    expect(JSON.parse(String(p['approvedBy']))).toEqual(['u2', 'u1'])
  })

  it('chi ha chiesto riceve la notifica, e solo a soddisfazione avvenuta', async () => {
    await firma({ approvalType: 'all', approvers: '["u1","u2"]', approvedBy: '[]' })
    expect(sendToUser).not.toHaveBeenCalled()
    await firma({ approvalType: 'any', approvers: '["u1"]', approvedBy: '[]' })
    expect(sendToUser).toHaveBeenCalledTimes(1)
    const [tenant, dest, notifica] = sendToUser.mock.calls[0] as [string, string, Record<string, unknown>]
    expect([tenant, dest]).toEqual(['t1', 'u9'])
    expect(notifica['type']).toBe('approval.approved')
  })
})

describe('approveRequest — l\'articolo della base di conoscenza', () => {
  function articoloApprovato(passi: Array<{ name: string; category: string }>, archi: Array<{ toStep: string }>) {
    statoDiPartenza({ entityType: 'kb_article', entityId: 'kb1', approvalType: 'any', approvers: '["u1"]', approvedBy: '[]' })
    // La seconda lettura cerca l'istanza di workflow dell'articolo.
    read.mockResolvedValueOnce({ records: [rec({ instanceId: 'wi1' })] })
    getWorkflowSteps.mockResolvedValue(passi)
    getAvailableTransitions.mockResolvedValue(archi)
  }

  it('va nel passo di CATEGORIA «published», non nel primo arco in avanti', async () => {
    articoloApprovato(
      [{ name: 'archiviato', category: 'closed' }, { name: 'pubblicato', category: 'published' }],
      [{ toStep: 'archiviato' }, { toStep: 'pubblicato' }],
    )
    transition.mockResolvedValue({ success: true })
    await approveRequest(null, { id: 'a1' }, ctx('u1'))
    expect((transition.mock.calls[0]![1] as Record<string, unknown>)['toStepName']).toBe('pubblicato')
  })

  it('se nessun passo raggiungibile è «published» non si inventa una strada', async () => {
    articoloApprovato(
      [{ name: 'archiviato', category: 'closed' }],
      [{ toStep: 'archiviato' }],
    )
    const r = await codice(() => approveRequest(null, { id: 'a1' }, ctx('u1')))
    expect(r.code).toBe('BAD_USER_INPUT')
    expect(r.message).toContain('no transition to a published step')
    expect(sendToUser).not.toHaveBeenCalled()
  })

  it('se il motore RIFIUTA, la mutation fallisce: non si dice «pubblicato» a vuoto', async () => {
    articoloApprovato([{ name: 'pubblicato', category: 'published' }], [{ toStep: 'pubblicato' }])
    transition.mockResolvedValue({ success: false, error: 'una guardia non passa' })
    const r = await codice(() => approveRequest(null, { id: 'a1' }, ctx('u1')))
    expect(r.code).toBe('CONFLICT')
    expect(r.message).toContain('una guardia non passa')
    expect(sendToUser).not.toHaveBeenCalled()
  })

  it('pubblicato davvero: la notifica dice «pubblicato», non «approvato»', async () => {
    articoloApprovato([{ name: 'pubblicato', category: 'published' }], [{ toStep: 'pubblicato' }])
    transition.mockResolvedValue({ success: true })
    await approveRequest(null, { id: 'a1' }, ctx('u1'))
    expect((sendToUser.mock.calls[0]![2] as Record<string, unknown>)['type']).toBe('kb.published')
  })

  it('un articolo senza istanza di workflow non fa fallire l\'approvazione', async () => {
    statoDiPartenza({ entityType: 'kb_article', entityId: 'kb1', approvalType: 'any', approvers: '["u1"]', approvedBy: '[]' })
    read.mockResolvedValueOnce({ records: [] })
    await approveRequest(null, { id: 'a1' }, ctx('u1'))
    expect(transition).not.toHaveBeenCalled()
    expect((sendToUser.mock.calls[0]![2] as Record<string, unknown>)['type']).toBe('kb.published')
  })
})

describe('rejectRequest', () => {
  it('le stesse porte: esiste, è pendente, e sei fra i firmatari', async () => {
    expect((await codice(() => rejectRequest(null, { id: 'a9', note: 'no' }, ctx()))).code).toBe('NOT_FOUND')

    read.mockResolvedValueOnce({ records: [rec({ status: 'approved', approvers: '["u1"]', requestedBy: 'u9', entityType: 'change', entityId: 'c1' })] })
    expect((await codice(() => rejectRequest(null, { id: 'a1', note: 'no' }, ctx()))).code).toBe('BAD_REQUEST')

    read.mockResolvedValueOnce({ records: [rec({ status: 'pending', approvers: '["u2"]', requestedBy: 'u9', entityType: 'change', entityId: 'c1' })] })
    expect((await codice(() => rejectRequest(null, { id: 'a1', note: 'no' }, ctx('u1')))).code).toBe('FORBIDDEN')
  })

  it('basta UN rifiuto, qualunque sia il tipo di approvazione, e il motivo si scrive', async () => {
    read.mockResolvedValueOnce({ records: [rec({ status: 'pending', approvers: '["u1","u2","u3"]', requestedBy: 'u9', entityType: 'change', entityId: 'c1' })] })
    write.mockResolvedValue({ records: [rigaAggiornata({ status: 'rejected', rejectedBy: 'u1' })] })
    const out = await rejectRequest(null, { id: 'a1', note: 'manca il piano' }, ctx('u1'))
    expect(out.status).toBe('rejected')
    const p = write.mock.calls[0]![1] as Record<string, unknown>
    expect(p).toMatchObject({ rejectedBy: 'u1', note: 'manca il piano' })
  })
})

describe('cancelApprovalRequest', () => {
  const inAttesa = (requestedBy: string) =>
    read.mockResolvedValueOnce({ records: [rec({ status: 'pending', requestedBy })] })

  it('la annulla chi l\'ha chiesta', async () => {
    inAttesa('u1')
    write.mockResolvedValue({ records: [rigaAggiornata({ status: 'cancelled' })] })
    expect((await cancelApprovalRequest(null, { id: 'a1' }, ctx('u1'))).status).toBe('cancelled')
  })

  it('un altro no, a meno che non possa decidere per qualunque squadra', async () => {
    inAttesa('u9')
    expect((await codice(() => cancelApprovalRequest(null, { id: 'a1' }, ctx('u1')))).code).toBe('FORBIDDEN')

    inAttesa('u9')
    write.mockResolvedValue({ records: [rigaAggiornata({ status: 'cancelled' })] })
    // `approval.override`: il permesso di decidere per qualunque squadra.
    const conOverride = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'x', permissions: new Set(['approval.override']) } as never
    expect((await cancelApprovalRequest(null, { id: 'a1' }, conOverride)).status).toBe('cancelled')
  })

  it('una già decisa non si annulla', async () => {
    read.mockResolvedValueOnce({ records: [rec({ status: 'rejected', requestedBy: 'u1' })] })
    expect((await codice(() => cancelApprovalRequest(null, { id: 'a1' }, ctx('u1')))).code).toBe('BAD_REQUEST')
  })
})

describe('createApprovalRequest', () => {
  it('nasce pendente, senza firme, e il tipo per difetto è «any»', async () => {
    write.mockResolvedValue({ records: [rigaAggiornata({ approvedBy: '[]' })] })
    await createApprovalRequest(null, { entityType: 'change', entityId: 'c1', title: 'T', approvers: ['u2'] }, ctx())
    const p = write.mock.calls[0]![1] as Record<string, unknown>
    expect(p['approvalType']).toBe('any')
    expect(p['tenantId']).toBe('t1')
    expect(String(write.mock.calls[0]![0])).toContain("status:         'pending'")
    expect(String(write.mock.calls[0]![0])).toContain("approved_by:    '[]'")
  })
})

describe('approvalRequests — la lista', () => {
  /** I parametri della query di pagina (la prima delle due letture). */
  const paginaChiesta = () => (read.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
  const cypherPagina = () => String((read.mock.calls[0] as unknown as [string])[0])

  beforeEach(() => { read.mockResolvedValue({ records: [] }) })

  it('la pagina la decide il server: mai più di cento, mai meno di uno', async () => {
    for (const [chiesta, attesa] of [[1000, 100], [0, 1], [undefined, 50]] as const) {
      read.mockClear()
      await approvalRequests(null, chiesta === undefined ? {} : { pageSize: chiesta }, ctx())
      expect(paginaChiesta()['limit']).toBe(attesa)
    }
  })

  it('`page` diventa uno SKIP, e una pagina zero o negativa è la prima', async () => {
    await approvalRequests(null, { page: 3, pageSize: 10 }, ctx())
    expect(paginaChiesta()).toMatchObject({ tenantId: 't1', skip: 20, limit: 10 })
    read.mockClear()
    await approvalRequests(null, { page: -7, pageSize: 10 }, ctx())
    expect(paginaChiesta()['skip']).toBe(0)
  })

  it('il tenant è la PRIMA condizione della WHERE, sempre', async () => {
    await approvalRequests(null, {}, ctx())
    expect(cypherPagina()).toContain('WHERE a.tenant_id = $tenantId')
  })

  it('si ordina solo sui quattro campi noti: uno inventato non entra nella query', async () => {
    await approvalRequests(null, { sortField: 'a.title; MATCH (x)', sortDirection: 'asc' }, ctx())
    expect(cypherPagina()).toContain('ORDER BY a.requested_at ASC')
    expect(cypherPagina()).not.toContain('MATCH (x)')
    read.mockClear()
    await approvalRequests(null, { sortField: 'status' }, ctx())
    expect(cypherPagina()).toContain('ORDER BY a.status DESC')
  })

  it('il totale arriva come Integer di Neo4j e diventa un numero JS', async () => {
    read.mockReset()
    read.mockResolvedValueOnce({ records: [] })
    read.mockResolvedValueOnce({ records: [{ get: () => ({ toNumber: () => 42 }) }] })
    expect((await approvalRequests(null, {}, ctx())).total).toBe(42)
  })
})
