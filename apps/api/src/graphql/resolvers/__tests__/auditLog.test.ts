/**
 * IL REGISTRO DELLE AZIONI (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/auditLog.ts` stava a ZERO. È un registro di CONFORMITÀ: la
 * domanda a cui deve rispondere è «chi ha fatto cosa, e quando», e chi la fa
 * di solito la fa dopo che è successo qualcosa. Tre cose che devono reggere, e
 * nessuna era verificata: il permesso, il tenant come PRIMA condizione della
 * WHERE, e il campo d'ordinamento che non finisce nella query se non è uno dei
 * quattro noti.
 *
 * ## E le due tendine
 * `auditActions` e `auditEntityTypes` non sono liste scritte a mano: le dice il
 * registro stesso. Il motivo sta nel file — le transizioni di workflow prima
 * si registravano sotto il nome del passo (`incident.assigned`) e ora sotto
 * un'azione stabile (`incident.step_entered`), e le voci storiche NON sono
 * state riscritte perché un registro di conformità non si riscrive. Le due
 * metà della storia convivono, e la tendina le mostra entrambe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    close,
  })),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { auditLog, auditActions, auditEntityTypes } = await import('../auditLog.js')

const ctx = (...permessi: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set(permessi),
}) as never
const AMMESSO = ctx('admin.audit')

const rec = (campi: Record<string, unknown>) => ({ get: (k: string) => campi[k] ?? null })

/** La query di pagina è la prima delle due letture. */
const pagina = () => txRun.mock.calls[0] as unknown as [string, Record<string, unknown>]

async function codice(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NESSUN RIFIUTO' } catch (e) {
    return String((e as GraphQLError).extensions?.['code'] ?? 'THROWN')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  txRun.mockResolvedValue({ records: [] })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('il permesso: `admin.audit`, e non si legge niente senza', () => {
  it.each([
    ['auditLog', () => auditLog(null, {}, ctx('incident.read'))],
    ['auditActions', () => auditActions(null, null, ctx('incident.read'))],
    ['auditEntityTypes', () => auditEntityTypes(null, null, ctx('incident.read'))],
  ] as const)('%s', async (_nome, chiama) => {
    expect(await codice(chiama)).toBe('FORBIDDEN')
    expect(txRun).not.toHaveBeenCalled()
  })
})

describe('auditLog — la pagina', () => {
  it('il tenant è la PRIMA condizione della WHERE, in tutte e due le query', async () => {
    await auditLog(null, {}, AMMESSO)
    expect(txRun).toHaveBeenCalledTimes(2)
    for (const [cypher, params] of txRun.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect(String(cypher)).toContain('WHERE a.tenant_id = $tenantId')
      expect(params['tenantId']).toBe('t1')
    }
  })

  it('la dimensione della pagina la decide il server: mai più di cento, mai meno di uno', async () => {
    for (const [chiesta, attesa] of [[1000, 100], [0, 1], [-5, 1], [undefined, 50]] as const) {
      txRun.mockClear()
      await auditLog(null, chiesta === undefined ? {} : { pageSize: chiesta }, AMMESSO)
      expect(pagina()[1]['limit']).toBe(attesa)
    }
  })

  it('`page` diventa uno SKIP, e una pagina zero o negativa è la prima', async () => {
    await auditLog(null, { page: 4, pageSize: 25 }, AMMESSO)
    expect(pagina()[1]['skip']).toBe(75)
    txRun.mockClear()
    await auditLog(null, { page: -3, pageSize: 25 }, AMMESSO)
    expect(pagina()[1]['skip']).toBe(0)
  })

  it('si ordina solo sui campi noti: uno inventato è rifiutato e NON entra nella query (A-22, 26 Sep 2026)', async () => {
    await expect(auditLog(null, { sortField: 'a.action; MATCH (x)', sortDirection: 'asc' }, AMMESSO)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.sort.unknownField' } } })
    txRun.mockClear()
    await auditLog(null, { sortField: 'ipAddress', sortDirection: 'asc' }, AMMESSO)
    expect(String(pagina()[0])).toContain('ORDER BY a.ip_address ASC')
    txRun.mockClear()
    await auditLog(null, { sortField: 'userEmail' }, AMMESSO)
    expect(String(pagina()[0])).toContain('ORDER BY a.user_email DESC')
  })

  it('le righe escono coi nomi dello schema, non con quelli del grafo', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({
      id: 'a1', userId: 'u9', userEmail: 'a@b', action: 'incident.created',
      entityType: 'Incident', entityId: 'i1', details: '{}', ipAddress: '10.0.0.1', createdAt: 'ieri',
    })] })
    txRun.mockResolvedValueOnce({ records: [rec({ total: 1 })] })
    const out = await auditLog(null, {}, AMMESSO)
    expect(out.items[0]).toEqual({
      id: 'a1', userId: 'u9', userEmail: 'a@b', action: 'incident.created',
      entityType: 'Incident', entityId: 'i1', details: '{}', ipAddress: '10.0.0.1', createdAt: 'ieri',
    })
  })

  it('un indirizzo IP o dei dettagli assenti restano null, non diventano stringhe vuote', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({ id: 'a1', action: 'x' })] })
    txRun.mockResolvedValueOnce({ records: [rec({ total: 1 })] })
    const out = await auditLog(null, {}, AMMESSO)
    expect(out.items[0]).toMatchObject({ details: null, ipAddress: null })
  })

  it('il totale arriva come Integer di Neo4j e diventa un numero JS', async () => {
    txRun.mockResolvedValueOnce({ records: [] })
    txRun.mockResolvedValueOnce({ records: [{ get: () => ({ toNumber: () => 4321 }) }] })
    expect((await auditLog(null, {}, AMMESSO)).total).toBe(4321)
  })

  it('nessuna riga di conteggio: zero, non NaN', async () => {
    expect((await auditLog(null, {}, AMMESSO)).total).toBe(0)
  })

  it('i filtri avanzati entrano nella WHERE come parametri, non interpolati', async () => {
    const filtro = JSON.stringify({ rules: [{ field: 'action', operator: 'equals', value: 'incident.created' }] })
    await auditLog(null, { filters: filtro }, AMMESSO)
    const [cypher, params] = pagina()
    expect(String(cypher)).toContain('a.tenant_id = $tenantId AND')
    expect(String(cypher)).not.toContain('incident.created')
    expect(Object.values(params)).toContain('incident.created')
  })

  it('un campo non ammesso nei filtri si rifiuta: la lista bianca è quella del registro', async () => {
    const filtro = JSON.stringify({ rules: [{ field: 'ip_address', operator: 'equals', value: '10.0.0.1' }] })
    expect(await codice(() => auditLog(null, { filters: filtro }, AMMESSO))).not.toBe('NESSUN RIFIUTO')
  })

  it('la sessione si chiude anche quando la query fallisce', async () => {
    txRun.mockRejectedValue(new Error('neo4j giù'))
    await auditLog(null, {}, AMMESSO).catch(() => { /* il punto è il finally */ })
    expect(close).toHaveBeenCalled()
  })
})

describe('le tendine le dice il REGISTRO, non una lista scritta a mano', () => {
  it('le azioni presenti, con quante voci ciascuna', async () => {
    txRun.mockResolvedValue({ records: [
      // Le due metà della storia convivono: la vecchia (nome del passo) e la
      // nuova (azione stabile). Un registro di conformità non si riscrive.
      rec({ action: 'incident.assigned', n: 12 }),
      rec({ action: 'incident.step_entered', n: 340 }),
    ] })
    expect(await auditActions(null, null, AMMESSO)).toEqual([
      { action: 'incident.assigned', count: 12 },
      { action: 'incident.step_entered', count: 340 },
    ])
    expect(String(txRun.mock.calls[0]![0])).toContain('ORDER BY action')
  })

  it('i tipi di entità presenti, saltando quelli vuoti', async () => {
    txRun.mockResolvedValue({ records: [rec({ entityType: 'ServiceRequest', n: 7 })] })
    expect(await auditEntityTypes(null, null, AMMESSO)).toEqual([{ entityType: 'ServiceRequest', count: 7 }])
    const cypher = String(txRun.mock.calls[0]![0])
    expect(cypher).toContain("a.entity_type IS NOT NULL AND a.entity_type <> ''")
    expect(cypher).toContain('tenant_id: $tenantId')
  })
})
