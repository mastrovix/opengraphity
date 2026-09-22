/**
 * DUE REDATTORI SULLA STESSA PAGINA (22 set 2026).
 *
 * L'articolo PORTA una `version` e una storia di versioni immutabili, ma
 * `updateKBArticle` non guardava nessuna delle due: il secondo salvataggio
 * sovrascriveva il primo in silenzio. Il testo non andava perduto — resta
 * nella storia — ma spariva da quello che i lettori vedono, e chi l'aveva
 * scritto lo scopriva per caso.
 *
 * Il prodotto risolve già questo problema in tre posti (policy degli eventi,
 * mappe dei servizi, definizioni di workflow) con lo stesso gesto. Qui
 * mancava, ed era l'unica entità con una `version` a non averlo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const articolo = { version: 3, lastEditedAt: '2026-09-22T08:00:00Z', lastEditedBy: 'Ada' }
const scritture: string[] = []

const record = (m: Record<string, unknown>) => ({ get: (k: string) => (k in m ? m[k] : null) })

const session = {
  executeRead: (fn: (tx: { run: (q: string) => Promise<{ records: unknown[] }> }) => unknown) =>
    fn({ run: async () => ({ records: articolo.version === 0 ? [] : [record({ id: 'kb-1', ...articolo })] }) }),
  executeWrite: (fn: (tx: { run: (q: string) => Promise<{ records: unknown[] }> }) => unknown) =>
    fn({ run: async (q: string) => { scritture.push(q); return { records: [record({ props: { id: 'kb-1', title: 't' } })] } } }),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => session,
  toNumber: (v: unknown) => Number(v),
  runQuery: async () => [],
  runQueryOne: async () => null,
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/domainMatrix.js', () => ({ assertDomainValue: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/embeddings.js', () => ({ normalizeKbTags: (t: string[]) => t }))
vi.mock('../../../lib/logger.js', () => {
  const finto = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => finto }
  return { logger: finto }
})
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { transition: vi.fn() } }))

const { updateKBArticle } = await import('../knowledgeBase.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u1@x.it', role: 'TENANT_ADMIN', permissions: perms('kb.write') } as never

beforeEach(() => { scritture.length = 0; articolo.version = 3 })

describe('updateKBArticle e la modifica concorrente', () => {
  it('la versione che il client ha letto è ancora quella: si salva', async () => {
    await updateKBArticle(null, { id: 'kb-1', title: 'nuovo', expectedVersion: 3 }, ctx)
    expect(scritture.length).toBe(1)
    expect(scritture[0]).toContain('a.version           = coalesce(a.version, 1) + 1')
  })

  it('qualcun altro ha scritto nel frattempo: si RIFIUTA, e si dice chi e quando', async () => {
    await expect(updateKBArticle(null, { id: 'kb-1', title: 'nuovo', expectedVersion: 2 }, ctx))
      .rejects.toThrow(/was modified by someone else.*expected version 2, current is 3.*by Ada.*2026-09-22/s)
    expect(scritture, 'non si deve scrivere niente quando si rifiuta').toEqual([])
  })

  it('un client che NON manda la versione si comporta come prima', async () => {
    await updateKBArticle(null, { id: 'kb-1', title: 'nuovo' }, ctx)
    expect(scritture.length).toBe(1)
  })

  it('articolo inesistente: NOT_FOUND, non un conflitto di versione', async () => {
    articolo.version = 0
    await expect(updateKBArticle(null, { id: 'kb-1', title: 'x', expectedVersion: 9 }, ctx))
      .rejects.toThrow(/Article not found/)
  })
})
