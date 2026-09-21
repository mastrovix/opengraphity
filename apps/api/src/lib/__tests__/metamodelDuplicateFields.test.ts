/**
 * I CAMPI DEFINITI DUE VOLTE si leggono e si dicono.
 *
 * Il difetto vero stava nel dato (la migrazione `20260920_1720` con `scope`
 * nella chiave del MERGE si è duplicata cinque campi, visti dal vivo come
 * «Priorità» due volte nelle tendine delle automazioni). Qui si tengono ferme
 * le due metà del rimedio che vivono nel codice: la lettura conta le
 * definizioni per NOME dentro un tipo, e il conteggio è di `f.id` distinti —
 * non di righe, che con un doppio legame direbbero due dove il campo è uno.
 */
import { describe, it, expect, vi } from 'vitest'
import { duplicateMetamodelFields } from '../metamodelDuplicateFields.js'

function sessione(righe: Array<Record<string, unknown>>) {
  const records = righe.map((r) => ({ get: (k: string) => r[k] }))
  return {
    executeRead: vi.fn(async (fn: (tx: { run: (q: string, p?: unknown) => Promise<unknown> }) => unknown) =>
      fn({ run: vi.fn(async () => ({ records })) }),
    ),
  } as never
}

describe('campi duplicati nel metamodello', () => {
  it('un metamodello pulito non produce rilievi', async () => {
    expect(await duplicateMetamodelFields(sessione([]), 't1')).toEqual([])
  })

  it('legge tipo, nome e quante definizioni ci sono', async () => {
    const out = await duplicateMetamodelFields(sessione([
      { typeName: 'incident', field: 'priority', quanti: 2 },
      { typeName: 'problem',  field: 'impact',   quanti: 3 },
    ]), 't1')
    expect(out).toEqual([
      { typeName: 'incident', field: 'priority', count: 2 },
      { typeName: 'problem',  field: 'impact',   count: 3 },
    ])
  })

  it('il conteggio arriva come numero anche da un Integer di Neo4j', async () => {
    const out = await duplicateMetamodelFields(sessione([
      { typeName: 'incident', field: 'urgency', quanti: { toNumber: () => 2, valueOf: () => 2 } },
    ]), 't1')
    expect(out[0]?.count).toBe(2)
  })

  it('la query conta gli id DISTINTI e guarda i tipi del tenant e di sistema', async () => {
    let query = ''
    const session = {
      executeRead: vi.fn(async (fn: (tx: { run: (q: string, p?: unknown) => Promise<unknown> }) => unknown) =>
        fn({ run: vi.fn(async (q: string) => { query = q; return { records: [] } }) }),
      ),
    } as never
    await duplicateMetamodelFields(session, 't1')
    expect(query).toContain('count(DISTINCT f.id)')
    expect(query).toContain("t.tenant_id IN [$tenantId, 'system']")
    expect(query).toContain("f.tenant_id IN [$tenantId, 'system']")
  })
})
