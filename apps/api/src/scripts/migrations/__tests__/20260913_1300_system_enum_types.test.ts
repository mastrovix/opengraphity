/**
 * Migrazione 20260913_1300_system_enum_types (personalizzazioni, ondata 1,
 * A-2 / C-6): i vocabolari spediti diventano nodi di sistema e i legami
 * `USES_ENUM` dei campi CONDIVISI si spostano su quelli.
 *
 * Si pinna: (a) i nodi di sistema si creano per ogni `SYSTEM_ENUMS`; (b) un
 * legame verso il vocabolario di un tenant viene spostato; (c) un legame già
 * sul vocabolario di sistema non si tocca; (d) se per un nome agganciato non
 * esiste il vocabolario di sistema la migrazione SI FERMA (non stacca il legame
 * al buio: il campo perderebbe i valori); (e) i vocabolari dei tenant non
 * vengono né riscritti né cancellati; (f) idempotenza.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { systemEnumTypes } from '../20260913_1300_system_enum_types.js'
import { MIGRATIONS } from '../index.js'
import { SYSTEM_ENUMS } from '../../../lib/seedEnumTypes.js'

interface LinkRow { fieldId: string; fieldName: string; fieldTenantId: string; enumId: string; enumName: string; enumTenantId: string }

function fakeSession(links: LinkRow[], systemEnumNames: string[]) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const rows = <T,>(list: T[]) => ({ records: list.map((r) => ({ get: (k: string) => (r as Record<string, unknown>)[k] })) })
  const present = new Set(systemEnumNames)
  return {
    calls,
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      calls.push({ cypher, params })
      // (a) MERGE del nodo di sistema
      if (cypher.includes('MERGE (e:EnumTypeDefinition {name: $name, tenant_id: $systemTenant})')) {
        const wasCreated = !present.has(String(params['name']))
        present.add(String(params['name']))
        return rows([{ wasCreated }])
      }
      // (b) elenco dei legami dei campi condivisi
      if (cypher.includes('MATCH (f:CIFieldDefinition)-[:USES_ENUM]->(e:EnumTypeDefinition)')) return rows(links)
      // (c) esiste il vocabolario di sistema con quel nome?
      if (cypher.includes('MATCH (e:EnumTypeDefinition {name: $name, tenant_id: $systemTenant}) RETURN e.id')) {
        return present.has(String(params['name'])) ? rows([{ id: `sys-${String(params['name'])}` }]) : rows([])
      }
      // (d) ri-aggancio
      if (cypher.includes('DELETE old')) return rows([{ id: `sys-${String(params['name'])}` }])
      return rows([])
    }),
  }
}

const link = (over: Partial<LinkRow> = {}): LinkRow => ({
  fieldId: 'f-1', fieldName: 'severity', fieldTenantId: 'system',
  enumId: 'e-cone', enumName: 'severity', enumTenantId: 'c-one', ...over,
})

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260913_1300_system_enum_types', () => {
  it('è registrata dopo l\'ondata 0, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260913_1300_system_enum_types')).toBeGreaterThan(ids.indexOf('20260912_1210_ci_status_vocabulary'))
    expect(systemEnumTypes.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(systemEnumTypes.autocommit).toBeUndefined()
  })

  it('semina UN nodo di sistema per ogni vocabolario spedito, con i valori del seed', async () => {
    const s = fakeSession([], [])
    await systemEnumTypes.up(s as never)
    const merges = s.calls.filter((c) => c.cypher.includes('MERGE (e:EnumTypeDefinition {name: $name'))
    expect(merges).toHaveLength(SYSTEM_ENUMS.length)
    expect(merges.map((m) => m.params['name'])).toEqual(SYSTEM_ENUMS.map((e) => e.name))
    for (const m of merges) expect(m.params['systemTenant']).toBe('system')
    const severity = merges.find((m) => m.params['name'] === 'severity')!
    expect(severity.params['values']).toEqual(SYSTEM_ENUMS.find((e) => e.name === 'severity')!.values)
  })

  it('sposta sul nodo di sistema il legame di un campo condiviso verso il vocabolario di un tenant', async () => {
    const s = fakeSession([link()], [])
    await systemEnumTypes.up(s as never)
    const move = s.calls.find((c) => c.cypher.includes('DELETE old'))!
    expect(move.params).toMatchObject({ fieldId: 'f-1', name: 'severity', fromTenant: 'c-one', systemTenant: 'system' })
    expect(move.cypher).toContain('MERGE (f)-[:USES_ENUM]->(sys)')
  })

  it('un legame già sul vocabolario di sistema non si tocca (idempotenza)', async () => {
    const s = fakeSession([link({ enumTenantId: 'system' })], SYSTEM_ENUMS.map((e) => e.name))
    await systemEnumTypes.up(s as never)
    expect(s.calls.filter((c) => c.cypher.includes('DELETE old'))).toHaveLength(0)
  })

  it('nome agganciato senza vocabolario spedito → SI FERMA e lo nomina, nessun legame staccato', async () => {
    const s = fakeSession([link({ enumName: 'colore_sede', fieldName: 'colore' })], [])
    await expect(systemEnumTypes.up(s as never)).rejects.toThrow(/nessun vocabolario spedito per "colore_sede"/)
    expect(s.calls.filter((c) => c.cypher.includes('DELETE old'))).toHaveLength(0)
  })

  it('non riscrive né cancella i vocabolari dei tenant: nessuna scrittura fuori da tenant_id = \'system\'', async () => {
    const s = fakeSession([link(), link({ fieldId: 'f-2', fieldName: 'impact', enumName: 'impact' })], [])
    await systemEnumTypes.up(s as never)
    for (const c of s.calls) {
      expect(c.cypher).not.toMatch(/DETACH DELETE|DELETE e\b/)
      if (c.cypher.includes('SET e.')) expect(c.params['systemTenant']).toBe('system')
    }
  })

  it('cerca i legami dei campi condivisi per tenant_id di sistema OPPURE scope base/itil', async () => {
    const s = fakeSession([], [])
    await systemEnumTypes.up(s as never)
    const list = s.calls.find((c) => c.cypher.includes('MATCH (f:CIFieldDefinition)-[:USES_ENUM]->(e:EnumTypeDefinition)'))!
    expect(list.cypher).toContain('f.tenant_id = $systemTenant OR f.scope IN $sharedScopes')
    expect(list.params['sharedScopes']).toEqual(['base', 'itil'])
  })
})
