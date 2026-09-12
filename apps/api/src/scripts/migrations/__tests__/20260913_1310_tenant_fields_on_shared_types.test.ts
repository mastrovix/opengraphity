/**
 * Migrazione 20260913_1310 (A-5): i campi di un cliente appesi ai tipi spediti
 * col prodotto si rimuovono, ma solo se nessun nodo porta davvero la proprietà.
 * Qui si pinnano le tre strade: niente da fare (dal vivo è questo il caso),
 * bonifica, e STOP sui campi valorizzati.
 */
import { describe, it, expect, vi } from 'vitest'
import { tenantFieldsOnSharedTypes } from '../20260913_1310_tenant_fields_on_shared_types.js'
import { MIGRATIONS } from '../index.js'

type Row = Record<string, unknown>
const rec = (map: Row) => ({ get: (k: string) => (k in map ? map[k] : null) })

/** Sessione finta: risponde nell'ordine delle `responses` passate. */
function fakeSession(responses: Array<Row[]>) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  let i = 0
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      return { records: (responses[i++] ?? []).map(rec) }
    }),
  }
}

const offender = (over: Row = {}): Row => ({
  fieldId: 'f-1', fieldName: 'costo_annuo', fieldScope: 'base',
  fieldTenant: 'c-two', isSystem: true, typeName: '__base__', typeTenant: 'system',
  ...over,
})

describe('20260913_1310_tenant_fields_on_shared_types', () => {
  it('è registrata, con id nel formato e prefisso dell\'agente B', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('20260913_1310_tenant_fields_on_shared_types')
    expect(tenantFieldsOnSharedTypes.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(tenantFieldsOnSharedTypes.id.startsWith('20260913_1310_')).toBe(true)
  })

  it('cerca i campi scope base/itil con un tenant_id diverso da system', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([[]])
    await tenantFieldsOnSharedTypes.up(s as never)
    const { cypher, params } = s.calls[0]!
    expect(cypher).toContain('MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)')
    expect(cypher).toContain('WHERE f.scope IN $shippedScopes')
    expect(cypher).toContain("coalesce(f.tenant_id, 'system') <> 'system'")
    expect(params).toEqual({ shippedScopes: ['base', 'itil'] })
  })

  it('nessun campo da bonificare (il caso del dimostrativo): lo dice e non scrive', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([[]])
    await tenantFieldsOnSharedTypes.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('niente da bonificare')
  })

  it('campo senza dati: DETACH DELETE del solo campo del proprietario, e il log lo nomina', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([[offender()], [{ n: 0 }], []])
    await tenantFieldsOnSharedTypes.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(3)

    // 1° passaggio: i nodi del proprietario che portano la proprietà
    expect(s.calls[1]!.cypher).toContain('$label IN labels(n) AND $fieldName IN keys(n)')
    expect(s.calls[1]!.params).toEqual({ tenantId: 'c-two', label: 'Base', fieldName: 'costo_annuo' })

    // 2° passaggio: la rimozione, scopata sul proprietario
    expect(s.calls[2]!.cypher).toContain('MATCH (f:CIFieldDefinition {id: $fieldId, tenant_id: $tenantId})')
    expect(s.calls[2]!.cypher).toContain('DETACH DELETE f')
    expect(s.calls[2]!.params).toEqual({ fieldId: 'f-1', tenantId: 'c-two' })

    const out = vi.mocked(console.log).mock.calls.at(-1)![0] as string
    expect(out).toContain('rimossi dai tipi spediti: 1')
    expect(out).toContain('__base__.costo_annuo (c-two, scope base) rimosso')
  })

  it('campo VALORIZZATO: si ferma nominando campo, tipo e quanti nodi, senza cancellare nulla', async () => {
    const s = fakeSession([[offender({ typeName: 'server', fieldScope: 'base' })], [{ n: 7 }]])
    await expect(tenantFieldsOnSharedTypes.up(s as never)).rejects.toThrow(/STOP/)
    expect(s.run).toHaveBeenCalledTimes(2)
    expect(s.calls.some((c) => c.cypher.includes('DETACH DELETE'))).toBe(false)

    const err = await tenantFieldsOnSharedTypes.up(fakeSession([[offender({ typeName: 'server' })], [{ n: 7 }]]) as never)
      .then(() => null, (e: unknown) => e as Error)
    expect(err!.message).toContain('server.costo_annuo (c-two): 7 nodi Server portano la proprietà')
  })

  it('più campi: il controllo dei dati precede OGNI cancellazione (uno valorizzato blocca tutti)', async () => {
    const s = fakeSession([
      [offender(), offender({ fieldId: 'f-2', fieldName: 'centro_costo', typeName: 'server' })],
      [{ n: 0 }],
      [{ n: 3 }],
    ])
    await expect(tenantFieldsOnSharedTypes.up(s as never)).rejects.toThrow(/centro_costo/)
    expect(s.calls.some((c) => c.cypher.includes('DETACH DELETE'))).toBe(false)
  })
})
