/**
 * Revisione del 14 set 2026 · F10: le notifiche in-app vivevano nella RAM di un
 * processo. Con due repliche i client collegati all'altra non ricevevano
 * niente, una ricarica svuotava il pannello, e un evento in ritardo di oltre
 * 60 secondi veniva scartato. Ora ogni notifica si salva (per tenant, con letto
 * e nascosto per persona) e si consegna attraverso un canale condiviso.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const run = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead:  (fn: (tx: { run: typeof run }) => unknown) => fn({ run }),
    executeWrite: (fn: (tx: { run: typeof run }) => unknown) => fn({ run }),
    close: vi.fn(async () => {}),
  })),
}))

const { sseManager } = await import('../sse.js')
const { persistInApp, listInbox, markInboxRead, markAllInboxRead, dismissInbox, pruneInbox } = await import('../inbox.js')

const notification = {
  id: 'n-1', type: 'mention', title: 'notification.mention.title', message: 'x',
  message_key: 'notification.mention.message', message_params: { author: 'Bob' },
  severity: 'info' as const, entity_id: 'inc-1', entity_type: 'incident', timestamp: '2026-09-14T10:00:00.000Z', read: false,
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('consegna in-app', () => {
  const written: string[] = []
  let clientId = ''
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    written.length = 0
    clientId = sseManager.connect('t1', 'u1', { write: (d: string) => { written.push(d) } })
  })
  afterEach(() => { sseManager.disconnect(clientId); sseManager.useTransport(null); vi.restoreAllMocks() })

  it('con un trasporto: salva e pubblica, e la scrittura ai client la fa chi riceve dal canale', async () => {
    const persist = vi.fn(async () => {})
    const publish = vi.fn(async () => {})
    sseManager.useTransport({ persist, publish })
    sseManager.sendToUser('t1', 'u1', notification)
    await flush()
    expect(persist).toHaveBeenCalledWith({ tenantId: 't1', userId: 'u1', notification })
    expect(publish).toHaveBeenCalledWith({ tenantId: 't1', userId: 'u1', notification })
    expect(written).toEqual([])
    sseManager.writeLocal({ tenantId: 't1', userId: 'u1', notification })
    expect(written).toHaveLength(1)
  })

  it('canale giù: la notifica è salvata e arriva almeno ai client di questo processo, e lo dice', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    sseManager.useTransport({ persist: vi.fn(async () => {}), publish: vi.fn(async () => { throw new Error('redis down') }) })
    sseManager.sendToTenant('t1', notification)
    await flush()
    expect(written).toHaveLength(1)
    expect(error).toHaveBeenCalled()
  })

  it('senza trasporto (processo singolo, test): scrittura locale come prima', () => {
    sseManager.sendToUser('t1', 'u1', notification)
    expect(written).toHaveLength(1)
  })
})

describe('archivio delle notifiche', () => {
  beforeEach(() => { run.mockReset() })

  it('salva una notifica per utente o per tutto il tenant', async () => {
    run.mockResolvedValue({ records: [] })
    await persistInApp({ tenantId: 't1', userId: 'u1', notification })
    const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('CREATE (n:InAppNotification')
    expect(params).toMatchObject({ id: 'n-1', tenantId: 't1', userId: 'u1', audience: 'user', createdAt: '2026-09-14T10:00:00.000Z', messageKey: 'notification.mention.message' })
    expect(JSON.parse(String(params['messageParams']))).toEqual({ author: 'Bob' })
    await persistInApp({ tenantId: 't1', userId: null, notification })
    expect((run.mock.calls[1] as [string, Record<string, unknown>])[1]).toMatchObject({ audience: 'tenant', userId: null })
  })

  it('elenco per persona: suo o del tenant, senza i nascosti, con lo stato letto', async () => {
    run.mockResolvedValueOnce({ records: [{ get: (k: string) => (k === 'props'
      ? { id: 'n-1', type: 'mention', title: 't', message: 'm', message_key: 'k', message_params: '{"a":"b"}', severity: 'info', entity_id: 'e', entity_type: 'incident', created_at: '2026-09-14T10:00:00.000Z' }
      : true) }] })
    const out = await listInbox('t1', 'u1', 50)
    const [cypher, params] = run.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain("n.audience = 'tenant' OR n.user_id = $userId")
    expect(cypher).toContain('DISMISSED_NOTIFICATION')
    expect(params).toMatchObject({ tenantId: 't1', userId: 'u1', limit: 50 })
    expect(out).toEqual([{ id: 'n-1', type: 'mention', title: 't', title_fallback: undefined, message: 'm', message_key: 'k', message_params: { a: 'b' }, severity: 'info', entity_id: 'e', entity_type: 'incident', timestamp: '2026-09-14T10:00:00.000Z', read: true }])
  })

  it('letto, tutto letto, nascondi e pulizia scrivono relazioni e cancellano per età', async () => {
    run.mockResolvedValue({ records: [{ get: () => 3 }] })
    await markInboxRead('t1', 'u1', 'n-1')
    expect(String(run.mock.calls[0]![0])).toContain('MERGE (u)-[r:READ_NOTIFICATION]->(n)')
    await markAllInboxRead('t1', 'u1')
    expect(String(run.mock.calls[1]![0])).toContain('READ_NOTIFICATION')
    await dismissInbox('t1', 'u1')
    expect(String(run.mock.calls[2]![0])).toContain('MERGE (u)-[:DISMISSED_NOTIFICATION]->(n)')
    await pruneInbox('2026-08-15T00:00:00.000Z')
    expect(String(run.mock.calls[3]![0])).toContain('n.created_at < $before')
  })
})
