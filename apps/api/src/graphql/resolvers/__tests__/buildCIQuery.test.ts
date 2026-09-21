/**
 * Filtro avanzato della lista CI (allCIs): i campi ammessi e la traduzione di
 * `health is_empty` (CI senza monitoraggio) — il link "Vedi i CI senza
 * monitoraggio" della pagina Salute CI apre la CMDB con questo filtro.
 */
import { describe, it, expect } from 'vitest'
import { ALL_CIS_ALLOWED_FIELDS, buildAdvancedWhere } from '../buildCIQuery.js'

describe('allCIs — filtro avanzato', () => {
  it('ammette health accanto ai campi base', () => {
    expect([...ALL_CIS_ALLOWED_FIELDS].sort()).toEqual(['createdAt', 'environment', 'health', 'name', 'status'])
  })

  it('health is_empty → IS NULL (CI mai toccato da un allarme); equals → confronto sul valore', () => {
    const params: Record<string, unknown> = {}
    const empty = buildAdvancedWhere(JSON.stringify({ rules: [{ id: 'r1', field: 'health', operator: 'is_empty', value: null, logic: 'AND' }] }), params, ALL_CIS_ALLOWED_FIELDS, 'n')
    expect(empty).toContain("(n.health IS NULL OR n.health = '')")
    const down = buildAdvancedWhere(JSON.stringify({ rules: [{ id: 'r2', field: 'health', operator: 'equals', value: 'down', logic: 'AND' }] }), params, ALL_CIS_ALLOWED_FIELDS, 'n')
    expect(down).toMatch(/n\.health = \$\w+/)
    expect(Object.values(params)).toContain('down')
  })

  it('un campo non ammesso fallisce, non viene ignorato', () => {
    expect(() => buildAdvancedWhere(JSON.stringify({ rules: [{ id: 'r3', field: 'secret', operator: 'is_empty', value: null, logic: 'AND' }] }), {}, ALL_CIS_ALLOWED_FIELDS, 'n')).toThrow(/not allowed/)
  })
})

/**
 * IL FILTRO DI UN CAMPO `ref_ci` (19 set 2026) passa da qui: il costruttore è
 * lo stesso delle liste CMDB, e l'insieme dei campi ammessi è quello che
 * `allCIs` allarga con le proprietà non di sistema dei tipi cercati. Questi
 * test pinnano le due metà di quella promessa — la proprietà del cliente si
 * può filtrare, e una proprietà che nessun tipo ha viene RIFIUTATA (non
 * ignorata, che vorrebbe dire una ricerca che offre tutto).
 */
describe('allCIs — filtro sulle proprietà del tipo di CI', () => {
  const ammessi = new Set([...ALL_CIS_ALLOWED_FIELDS, 'manufacturer', 'criticality'])
  const regola = (field: string, operator: string, value: unknown) =>
    JSON.stringify({ rules: [{ id: 'r', field, operator, value, logic: 'AND' }] })

  it('una proprietà del tipo entra nella WHERE con il suo valore', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(regola('manufacturer', 'equals', 'Dell'), params, ammessi, 'n')
    expect(where).toMatch(/n\.manufacturer = \$\w+/)
    expect(Object.values(params)).toContain('Dell')
  })

  it('una proprietà che nessun tipo cercato ha viene rifiutata', () => {
    expect(() => buildAdvancedWhere(regola('rack_unit', 'equals', '3'), {}, ammessi, 'n')).toThrow(/not allowed/)
  })
})
