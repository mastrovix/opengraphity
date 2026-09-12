/**
 * `loadITILTypes` di @opengraphity/schema-generator (personalizzazioni,
 * ondata 1 — A1-1 punti 3 e 5).
 *
 * Due buchi sulla stessa query: `OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef)`
 * senza filtro sul tenant del vocabolario, e `WHERE t.scope='itil' AND
 * t.active=true` con `$tenantId` passato e MAI usato — nemmeno sul tipo.
 *
 * Il pacchetto non può importare `apps/api` (è il contrario), e la regola di
 * isolamento ha una sorgente sola: `lib/enumScope.ts`. Quindi gliela passiamo
 * (`EnumScope`), e qui si pinna che la passi davvero: la Cypher esce con i tre
 * filtri e le righe passano da `applyEnumOverrides`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead:  (fn: (tx: { run: typeof run }) => unknown) => fn({ run }),
    executeWrite: (fn: (tx: { run: typeof run }) => unknown) => fn({ run }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))

const { loadITILTypes } = await import('@opengraphity/schema-generator')
const { enumScopeClause, loadTenantEnumOverrides, applyEnumOverrides } = await import('../enumScope.js')

const ENUM_SCOPE = { clause: enumScopeClause, loadOverrides: loadTenantEnumOverrides, applyOverrides: applyEnumOverrides }
const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

const typeRow = (fieldData: unknown[]) => rec({
  t: { properties: { id: 't-1', name: 'incident', label: 'Incident', tenant_id: 'system', active: true, scope: 'itil' } },
  fieldData,
})
const field = (over: Record<string, unknown> = {}) => ({
  props: { properties: { id: 'f-1', name: 'severity', label: 'Severità', field_type: 'enum', order: 1 } },
  enumId: 'sys-1', enumName: 'severity', enumValues: ['low', 'high'], ...over,
})

beforeEach(() => { run.mockReset() })

describe('loadITILTypes — ambito iniettato', () => {
  it('filtra il TIPO per tenant (il $tenantId non usato), i CAMPI per tenant e il VOCABOLARIO con enumScopeClause', async () => {
    run.mockResolvedValue({ records: [] })
    await loadITILTypes('c-two', ENUM_SCOPE)

    // la prima run è loadTenantEnumOverrides, la seconda la query dei tipi
    const [cypher, params] = run.mock.calls[1] as unknown as [string, Record<string, unknown>]
    expect(cypher).toContain("t.tenant_id IN [$tenantId, 'system']")
    expect(cypher).toContain("WHERE f.tenant_id IN [$tenantId, 'system']")
    expect(cypher).toContain("WHERE enumDef.tenant_id IN [$tenantId, 'system']")
    expect(params).toEqual({ tenantId: 'c-two' })
  })

  it('senza personalizzazioni i valori sono quelli del vocabolario agganciato', async () => {
    run.mockResolvedValueOnce({ records: [] })                        // overrides
    run.mockResolvedValueOnce({ records: [typeRow([field()])] })
    const out = await loadITILTypes('c-two', ENUM_SCOPE)
    expect(out[0]!.fields[0]!.enumValues).toEqual(['low', 'high'])
  })

  it('il vocabolario del tenant con lo stesso nome vince (precedenza del contratto)', async () => {
    run.mockResolvedValueOnce({ records: [rec({ id: 'own-1', name: 'severity', values: ['bassa', 'alta'] })] })
    run.mockResolvedValueOnce({ records: [typeRow([field()])] })
    const out = await loadITILTypes('c-one', ENUM_SCOPE)
    expect(out[0]!.fields[0]!.enumValues).toEqual(['bassa', 'alta'])
  })

  it('un campo senza vocabolario agganciato non viene inventato', async () => {
    run.mockResolvedValueOnce({ records: [] })
    run.mockResolvedValueOnce({ records: [typeRow([field({ enumId: null, enumName: null, enumValues: null })])] })
    const out = await loadITILTypes('c-two', ENUM_SCOPE)
    expect(out[0]!.fields[0]!.enumValues).toEqual([])
  })
})
