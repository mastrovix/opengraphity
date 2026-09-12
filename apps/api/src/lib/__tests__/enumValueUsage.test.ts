/**
 * lib/enumValueUsage.ts — chi sta usando un valore di un vocabolario
 * (ondata 7 · B7-2 / A-13).
 *
 * Cosa pinna questo test:
 *  - i campi si cercano per NOME del vocabolario, non per id e non per
 *    proprietario del nodo agganciato: la personalizzazione dell'ondata 1 è una
 *    copia per tenant con lo stesso nome, e dal vivo i `USES_ENUM` puntano
 *    tutti ai nodi di UN cliente (C-6) — filtrare troverebbe zero campi su
 *    ogni altro tenant e permetterebbe di togliere un valore ancora in uso;
 *  - `__base__` non è un'etichetta di nodo: i CI sono `ConfigurationItem`;
 *  - la proprietà è lo snake_case del campo, e ci finiscono anche `chain` e
 *    `type` (proprietà riservate ma reali);
 *  - la semantica del ciclo di vita conta come uso.
 */
import { describe, it, expect, vi } from 'vitest'
import { int } from 'neo4j-driver'

vi.mock('../ciLifecycle.js', () => ({
  CI_STATUS_VOCABULARY: 'ci_status',
  lifecyclePolicyReferences: vi.fn(async (_s: unknown, _t: string, value: string) =>
    (value === 'decommissioned' ? ['retired_statuses'] : [])),
}))

const {
  enumValueBindings, countEnumValueUsage, enumValueUsageMessage, replaceEnumValue,
  BASE_TYPE_PLACEHOLDER, BASE_TYPE_LABEL,
} = await import('../enumValueUsage.js')

type Row = Record<string, unknown>
const rec = (m: Row) => ({ keys: Object.keys(m), get: (k: string) => (k in m ? m[k] : null) })

/** Sessione finta: risponde in coda, e registra le query. */
function fakeSession(responses: Row[][]) {
  const queue = [...responses]
  const calls: Array<{ cypher: string; params: Row }> = []
  const run = vi.fn(async (cypher: string, params?: Row) => {
    calls.push({ cypher, params: params ?? {} })
    return { records: (queue.shift() ?? []).map(rec) }
  })
  const tx = { run }
  return {
    calls, run,
    executeRead:  (fn: (t: typeof tx) => unknown) => fn(tx),
    executeWrite: (fn: (t: typeof tx) => unknown) => fn(tx),
  }
}

describe('enumValueBindings', () => {
  it('cerca i campi per NOME del vocabolario, con l\'isolamento sul TIPO; `__base__` → ConfigurationItem; proprietà in snake_case', async () => {
    const s = fakeSession([[
      { label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' },
      { label: 'DatabaseInstance', typeName: 'database_instance', fieldName: 'instanceType' },
    ]])
    const out = await enumValueBindings(s as never, 'acme', 'ci_status')
    expect(out).toEqual([
      { label: BASE_TYPE_LABEL, property: 'status', fieldName: 'status', typeName: '__base__' },
      { label: 'DatabaseInstance', property: 'instance_type', fieldName: 'instanceType', typeName: 'database_instance' },
    ])
    const { cypher, params } = s.calls[0]!
    expect(cypher).toContain('USES_ENUM]->(e:EnumTypeDefinition {name: $name})')
    // Il proprietario del nodo agganciato NON filtra: dal vivo i campi
    // condivisi puntano ai nodi di un solo cliente (C-6), e filtrarlo
    // permetterebbe di togliere un valore ancora in uso su ogni altro tenant.
    expect(cypher).not.toContain("e.tenant_id IN [$tenantId, 'system']")
    expect(cypher).toContain("t.scope IN ['base', 'itil'] OR t.tenant_id = $tenantId")
    // `__base__` è `active = false` per costruzione (dal vivo) e porta il
    // campo `status`: un filtro sull'attivo escluderebbe proprio lui.
    expect(cypher).not.toMatch(/coalesce\(t\.active/)
    expect(params).toEqual({ tenantId: 'acme', name: 'ci_status' })
  })

  it('`chain` e `type` sono proprietà riservate ma REALI: contarle deve funzionare', async () => {
    const s = fakeSession([[
      { label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'chain' },
      { label: 'Change', typeName: 'change', fieldName: 'type' },
    ]])
    await expect(enumValueBindings(s as never, 'acme', 'ci_chain')).resolves.toEqual([
      { label: BASE_TYPE_LABEL, property: 'chain', fieldName: 'chain', typeName: '__base__' },
      { label: 'Change', property: 'type', fieldName: 'type', typeName: 'change' },
    ])
  })

  it('un\'etichetta non valida è un errore, non un\'interpolazione a occhi chiusi', async () => {
    const s = fakeSession([[{ label: 'Bad Label; MATCH (n) DETACH DELETE n', typeName: 'x', fieldName: 'y' }]])
    await expect(enumValueBindings(s as never, 'acme', 'ci_status')).rejects.toThrow(/invalid Neo4j label/)
  })
})

describe('countEnumValueUsage', () => {
  it('conta i record per tipo e aggiunge la semantica del ciclo di vita fra gli usi', async () => {
    const s = fakeSession([
      [{ label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' }],
      // le due forme in cui `count(...)` può arrivare: `Integer` del driver e
      // `number` normale. Il convertitore è `toNumber` di @opengraphity/neo4j,
      // uno solo — un `.toNumber()` a mano è il difetto che ha rotto
      // `deleteEnumType`.
      [{ value: 'decommissioned', n: int(12) }, { value: 'expired', n: 49 }],
    ])
    const out = await countEnumValueUsage(s as never, 'acme', 'ci_status', ['decommissioned', 'expired', 'mai_usato'])
    expect(out).toEqual([
      { value: 'decommissioned', records: [{ typeName: '__base__', fieldName: 'status', count: 12 }], policyLists: ['retired_statuses'], total: 13 },
      { value: 'expired',        records: [{ typeName: '__base__', fieldName: 'status', count: 49 }], policyLists: [], total: 49 },
    ])
    expect(s.calls[1]!.cypher).toContain('MATCH (n:ConfigurationItem {tenant_id: $tenantId})')
    expect(s.calls[1]!.cypher).toContain('WHERE n.status IN $values')
  })

  it('nessun valore da controllare → nessuna query', async () => {
    const s = fakeSession([])
    await expect(countEnumValueUsage(s as never, 'acme', 'ci_status', [])).resolves.toEqual([])
    expect(s.run).not.toHaveBeenCalled()
  })

  it('un vocabolario che non è `ci_status` non passa dalla semantica del ciclo di vita', async () => {
    const s = fakeSession([
      [{ label: 'Incident', typeName: 'incident', fieldName: 'severity' }],
      [{ value: 'blocker', n: 3 }],
    ])
    const out = await countEnumValueUsage(s as never, 'acme', 'severity', ['blocker'])
    expect(out).toEqual([{ value: 'blocker', records: [{ typeName: 'incident', fieldName: 'severity', count: 3 }], policyLists: [], total: 3 }])
  })
})

describe('enumValueUsageMessage', () => {
  it('dice quanti record, dove, e la via d\'uscita', () => {
    const msg = enumValueUsageMessage('ci_status', [
      { value: 'decommissioned', records: [{ typeName: '__base__', fieldName: 'status', count: 12 }], policyLists: ['retired_statuses'], total: 13 },
    ])
    expect(msg).toContain('Il vocabolario "ci_status" non può perdere questi valori')
    expect(msg).toContain('"decommissioned" è ancora usato da 12 __base__.status, la policy degli allarmi (retired_statuses)')
    expect(msg).toContain('replacements: [{from: "…", to: "…"}]')
  })
})

describe('replaceEnumValue', () => {
  it('riscrive i record e le liste della policy nella transazione del chiamante', async () => {
    const policy = { ignore_lifecycle_statuses: ['decommissioned'], retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'] }
    const s = fakeSession([
      [{ label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' }],
      [{ n: 12 }],
      [{ raw: JSON.stringify(policy) }],
      [],
    ])
    await expect(replaceEnumValue(s as never, 'acme', 'ci_status', 'decommissioned', 'dismesso')).resolves.toBe(12)
    expect(s.calls[1]!.cypher).toContain('SET n.status = $to')
    expect(s.calls[1]!.params).toMatchObject({ tenantId: 'acme', from: 'decommissioned', to: 'dismesso' })
    expect(JSON.parse(s.calls[3]!.params['policy'] as string)).toEqual({
      ignore_lifecycle_statuses: ['dismesso'],
      retired_statuses:          ['inactive', 'dismesso'],
      maintenance_statuses:      ['maintenance'],
    })
  })

  it('policy che non cita il valore → non la riscrive', async () => {
    const s = fakeSession([
      [{ label: BASE_TYPE_PLACEHOLDER, typeName: '__base__', fieldName: 'status' }],
      [{ n: 0 }],
      [{ raw: JSON.stringify({ retired_statuses: ['inactive'] }) }],
    ])
    await replaceEnumValue(s as never, 'acme', 'ci_status', 'decommissioned', 'dismesso')
    expect(s.calls.some((c) => c.cypher.includes('SET t.event_policy'))).toBe(false)
  })
})
