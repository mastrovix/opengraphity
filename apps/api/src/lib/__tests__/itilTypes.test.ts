/**
 * itilTypes — the ITIL metamodel read shared by the GraphQL `itilTypes` query
 * and the report entity catalogue.
 *
 * Why it matters: this is where a tenant sees its own fields plus the shipped
 * ones and never another tenant's; where a tenant dictionary with the same name
 * overrides the shipped one; and where a corrupt JSON in the graph must fail
 * with a message that says WHAT is corrupt rather than a bare SyntaxError that
 * leaves an administrator guessing which of hundreds of fields broke the form.
 */
import { describe, it, expect, vi } from 'vitest'
import { FIELD_SCOPE, mapITILField, mapFieldRows, loadITILTypes } from '../itilTypes.js'

const node = (properties: Record<string, unknown>) => ({ properties })

/** A fake session answering the two reads: tenant dictionaries, then types. */
function fakeSession(opts: { overrides?: Array<Record<string, unknown>>; types: Array<Record<string, unknown>> }) {
  const run = vi.fn(async (q: string, params: Record<string, unknown>) => {
    const rows = q.includes('EnumTypeDefinition {tenant_id: $tenantId}') ? (opts.overrides ?? []) : opts.types
    return { records: rows.map((row) => ({ get: (k: string) => row[k] })), params }
  })
  return { session: { executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run })) } as never, run }
}

describe('FIELD_SCOPE', () => {
  it('lets a tenant see its own fields and the shipped ones, nothing else', () => {
    expect(FIELD_SCOPE).toBe("f.tenant_id IN [$tenantId, 'system']")
  })
})

describe('mapITILField', () => {
  it('applies the defaults of a minimal field', () => {
    expect(mapITILField({ id: 'f1', name: 'x', label: 'X', field_type: 'string' })).toEqual({
      id: 'f1', name: 'x', label: 'X', fieldType: 'string', required: false, defaultValue: null,
      enumValues: [], order: 0, validationScript: null, visibilityScript: null, defaultScript: null,
      isSystem: false, enumTypeId: null, enumTypeName: null, visibleToEndUser: false,
      stepVisibilityRaw: null, stepEditabilityRaw: null,
    })
  })

  it('uses inline enum_values when no dictionary is attached, the dictionary when it is', () => {
    const f = { id: 'f', name: 'sev', enum_values: '["a","b"]', order: '3', visible_to_end_user: true, step_visibility: '["new"]' }
    const inline = mapITILField(f)
    expect(inline.enumValues).toEqual(['a', 'b'])
    expect(inline.order).toBe(3)
    expect(inline.visibleToEndUser).toBe(true)
    expect(inline.stepVisibilityRaw).toBe('["new"]')
    const linked = mapITILField(f, { id: 'e1', name: 'severity', values: ['low', 'high'] })
    expect(linked).toMatchObject({ enumValues: ['low', 'high'], enumTypeId: 'e1', enumTypeName: 'severity' })
  })

  it('a corrupt inline enum_values names what is corrupt', () => {
    expect(() => mapITILField({ enum_values: '{not json' })).toThrow(/^enum_values is not valid JSON .*\{not json/)
    expect(() => mapITILField({ enum_values: '{"a":1}' })).toThrow(/^enum_values is not a JSON array/)
  })

  it('visibleToEndUser is only true for a real boolean true', () => {
    // The portal shows only explicitly marked fields: a truthy string must not leak a field.
    expect(mapITILField({ visible_to_end_user: 'true' }).visibleToEndUser).toBe(false)
  })
})

describe('mapFieldRows', () => {
  const row = (props: Record<string, unknown>, enumId: string | null = null, enumName: string | null = null, enumValues: string[] | string | null = null) =>
    ({ props, enumId, enumName, enumValues })

  it('sorts by order and parses dictionary values stored as JSON strings', () => {
    const out = mapFieldRows([
      row({ id: 'b', order: 2 }),
      row({ id: 'a', order: 1 }, 'e1', 'severity', '["x","y"]'),
      row({ id: 'c' }, 'e2', null, null),
    ], new Map())
    expect(out.map((f) => f.id)).toEqual(['c', 'a', 'b'])
    expect(out[1]!.enumValues).toEqual(['x', 'y'])
    // A dictionary without a name keeps its id as the diagnostic name and an empty label.
    expect(out[0]!).toMatchObject({ enumTypeId: 'e2', enumTypeName: '', enumValues: [] })
  })

  it('a tenant dictionary with the same name wins over the shipped one', () => {
    const out = mapFieldRows(
      [row({ id: 'sev' }, 'sys-sev', 'severity', ['low', 'high'])],
      new Map([['severity', { id: 'own-sev', name: 'severity', values: ['minor', 'major'] }]]),
    )
    expect(out[0]).toMatchObject({ enumTypeId: 'own-sev', enumValues: ['minor', 'major'] })
  })

  it('a corrupt dictionary names the dictionary', () => {
    expect(() => mapFieldRows([row({ id: 'x' }, 'e1', 'severity', 'nope')], new Map()))
      .toThrow(/Dictionary "severity": values is not valid JSON/)
    expect(() => mapFieldRows([row({ id: 'x' }, 'e1', null, '"str"')], new Map()))
      .toThrow(/Dictionary "e1": values is not a JSON array/)
  })
})

describe('loadITILTypes', () => {
  it('scopes the read to the tenant plus system, and maps types with their fields', async () => {
    const { session, run } = fakeSession({
      overrides: [{ id: 'own-sev', name: 'severity', values: ['minor'] }],
      types: [
        {
          t: node({ id: 't1', name: 'incident', label: 'Incident', active: true, scope: 'itil', tenant_id: 'system', neo4j_label: 'Incident', icon: 'bolt', color: 'red', validation_script: 'x' }),
          fieldData: [
            { f: node({ id: 'f2', name: 'sev', order: 2 }), enumTypeId: 'sys-sev', enumTypeName: 'severity', enumTypeValues: ['low'] },
            { f: node({ id: 'f1', name: 'title', order: 1 }), enumTypeId: null, enumTypeName: null, enumTypeValues: null },
            // OPTIONAL MATCH with no field yields a null placeholder: it must be dropped.
            { f: null, enumTypeId: null, enumTypeName: null, enumTypeValues: null },
          ],
        },
        { t: node({ id: 't2', name: 'change', label: 'Change', active: true }), fieldData: [] },
      ],
    })
    const types = await loadITILTypes(session, 'tenant-a')

    const typeQuery = run.mock.calls[1]!
    expect(typeQuery[0]).toContain("t.tenant_id IN [$tenantId, 'system']")
    expect(typeQuery[0]).toContain(FIELD_SCOPE)
    expect(typeQuery[0]).toContain("enumDef.tenant_id IN [$tenantId, 'system']")
    expect(typeQuery[1]).toEqual({ tenantId: 'tenant-a' })

    expect(types[0]).toMatchObject({ id: 't1', name: 'incident', neo4jLabel: 'Incident', icon: 'bolt', color: 'red', validationScript: 'x', tenantId: 'system', relations: [], systemRelations: [] })
    expect(types[0]!.fields.map((f) => f.id)).toEqual(['f1', 'f2'])
    expect(types[0]!.fields[1]).toMatchObject({ enumTypeId: 'own-sev', enumValues: ['minor'] })
    // Defaults for a type written without the optional properties.
    expect(types[1]).toMatchObject({ neo4jLabel: null, icon: '', color: '', scope: 'itil', tenantId: 'system', validationScript: null, fields: [] })
  })
})
