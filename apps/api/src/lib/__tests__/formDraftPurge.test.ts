/**
 * lib/formDraftPurge.ts — le bozze mai reclamate (moduli del catalogo, ondata 2).
 *
 * Quello che va tenuto fermo è l'ORDINE e il comportamento sull'errore: prima
 * il file, poi il nodo. Al contrario, un errore sul disco lascerebbe un file
 * che nessuno sa più di avere — un nodo cancellato porta via anche il percorso.
 * E un file che non si cancella deve LASCIARE il suo nodo, così la passata di
 * domani riprova invece di dimenticarsene.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: vi.fn() }),
  runQuery: (...args: unknown[]) => runQuery(...args),
}))
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { child: () => child, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const unlink = vi.fn()
vi.mock('node:fs/promises', () => ({ unlink: (p: string) => unlink(p) }))

const { purgeFormDrafts } = await import('../formDraftPurge.js')

/** Prima chiamata: i candidati. Seconda: la cancellazione dei nodi. */
function conCandidati(candidati: Array<{ id: string; storagePath: string | null; tenantId: string }>, cancellati = candidati.length) {
  runQuery.mockReset()
  runQuery.mockImplementation(async (_s: unknown, query: string) => {
    if (query.includes('RETURN a.id AS id')) return candidati
    if (query.includes('DETACH DELETE a')) return [{ n: cancellati }]
    return []
  })
}

beforeEach(() => { unlink.mockReset(); unlink.mockResolvedValue(undefined) })

describe('purgeFormDrafts', () => {
  it('cancella il file e poi il nodo', async () => {
    conCandidati([{ id: 'a1', storagePath: '/dati/a1_preventivo.pdf', tenantId: 't1' }])
    const r = await purgeFormDrafts('2026-10-02T00:00:00.000Z')
    expect(unlink).toHaveBeenCalledWith('/dati/a1_preventivo.pdf')
    expect(r).toEqual({ nodes: 1, files: 1, filesFailed: 0 })
  })

  it('un file che non c\'è più (ENOENT) non è un errore: il nodo va via comunque', async () => {
    conCandidati([{ id: 'a1', storagePath: '/dati/spartito.pdf', tenantId: 't1' }])
    unlink.mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    const r = await purgeFormDrafts('2026-10-02T00:00:00.000Z')
    expect(r).toEqual({ nodes: 1, files: 0, filesFailed: 0 })
  })

  it('un file che NON si cancella lascia il suo nodo: domani si riprova', async () => {
    conCandidati([
      { id: 'buono', storagePath: '/dati/buono.pdf', tenantId: 't1' },
      { id: 'bloccato', storagePath: '/dati/bloccato.pdf', tenantId: 't1' },
    ], 1)
    unlink.mockImplementation(async (percorso: string) => {
      if (percorso.includes('bloccato')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const r = await purgeFormDrafts('2026-10-02T00:00:00.000Z')
    expect(r).toEqual({ nodes: 1, files: 1, filesFailed: 1 })
    // Il DETACH DELETE ha ricevuto SOLO l'id del file andato via.
    const cancellazione = runQuery.mock.calls.find((c) => String(c[1]).includes('DETACH DELETE a'))
    expect((cancellazione?.[2] as { ids: string[] }).ids).toEqual(['buono'])
  })

  it('un nodo senza percorso su disco si cancella e basta', async () => {
    conCandidati([{ id: 'a1', storagePath: null, tenantId: 't1' }])
    const r = await purgeFormDrafts('2026-10-02T00:00:00.000Z')
    expect(unlink).not.toHaveBeenCalled()
    expect(r).toEqual({ nodes: 1, files: 0, filesFailed: 0 })
  })

  it('niente da cancellare: nessuna scrittura', async () => {
    conCandidati([])
    const r = await purgeFormDrafts('2026-10-02T00:00:00.000Z')
    expect(r).toEqual({ nodes: 0, files: 0, filesFailed: 0 })
    expect(runQuery.mock.calls.some((c) => String(c[1]).includes('DETACH DELETE a'))).toBe(false)
  })
})
