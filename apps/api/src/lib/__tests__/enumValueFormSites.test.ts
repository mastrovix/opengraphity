/**
 * lib/enumValueFormSites.ts — the Dictionary values kept by the catalog forms
 * (review of 23 Sep 2026).
 *
 * What an admin loses if these regress: renaming `produzione` → `prod` left
 * `visibleWhen: ambiente eq produzione` in the form, so the required field it
 * guarded was never asked again; the answers of the requests kept the old
 * value, and the count said «no uses», so a removal went through too.
 */
import { describe, it, expect, vi } from 'vitest'
import { int } from 'neo4j-driver'

const { formValueReferences, replaceInForms } = await import('../enumValueFormSites.js')

type Row = Record<string, unknown>
const rec = (m: Row) => ({ keys: Object.keys(m), get: (k: string) => (k in m ? m[k] : null) })

const FORM = {
  version: 1, revision: 3,
  sections: [{
    id: 'main', title: {},
    visibleWhen: { match: 'all', rules: [{ field: 'ambiente', op: 'ne', value: 'test' }] },
    items: [
      { field: 'ambiente', defaultValue: 'produzione' },
      { field: 'approvazione_cab', visibleWhen: { match: 'any', rules: [{ field: 'ambiente', op: 'eq', value: 'produzione' }, { field: 'costo', op: 'gt', value: 'produzione' }] } },
    ],
  }],
}
const TABLE = JSON.stringify({ version: 1, columns: [{ name: 'env', fieldType: 'enum', vocabulary: 'environment' }, { name: 'note', fieldType: 'text' }] })

/** A session that answers by the Cypher it is given, and records every call. */
function fakeGraph(answer: (cypher: string, params: Row) => Row[]) {
  const calls: Array<{ cypher: string; params: Row }> = []
  const run = vi.fn(async (cypher: string, params: Row = {}) => {
    calls.push({ cypher, params })
    return { records: answer(cypher, params).map(rec) }
  })
  return { calls, run, executeRead: (fn: (t: { run: typeof run }) => unknown) => fn({ run }) }
}

function library(cypher: string): Row[] | null {
  if (!cypher.includes('MATCH (f:FormField')) return null
  return [
    { name: 'ambiente', fieldType: 'enum', vocabulary: 'environment', tableDefinition: null },
    { name: 'sistemi', fieldType: 'multi_enum', vocabulary: 'environment', tableDefinition: null },
    { name: 'costo', fieldType: 'number', vocabulary: null, tableDefinition: null },
    { name: 'righe', fieldType: 'table', vocabulary: null, tableDefinition: TABLE },
  ]
}

describe('formValueReferences', () => {
  it('counts the answers (single and multiple choice) and the table cells as records, the conditions and defaults as sites', async () => {
    const g = fakeGraph((cypher, params) => {
      const lib = library(cypher)
      if (lib) return lib
      if (cypher.includes('UNWIND s[$prop]')) return params['prop'] === 'sistemi' ? [{ value: 'produzione', n: int(2) }] : []
      if (cypher.includes('WHERE s[$prop] IN $values')) return params['prop'] === 'ambiente' ? [{ value: 'produzione', n: int(5) }] : []
      if (cypher.includes('FORM_TABLE_ROW')) return [{ value: 'produzione', n: int(1) }]
      if (cypher.includes('MATCH (i:ServiceCatalogItem')) return [
        { name: 'New server', form: JSON.stringify(FORM) },
        { name: 'Broken', form: '{not json' },
      ]
      return []
    })
    const out = await formValueReferences(g as never, 't1', 'environment', ['produzione', 'test'])
    expect(out.records.get('produzione')).toEqual([
      { typeName: 'ServiceRequest', fieldName: 'ambiente', count: 5 },
      { typeName: 'ServiceRequest', fieldName: 'sistemi', count: 2 },
      { typeName: 'FormTableRow', fieldName: 'righe.env', count: 1 },
    ])
    // The condition and the default on `ambiente` name the value; the rule on `costo` (another field) does not count.
    expect(out.sites.get('produzione')).toEqual(['the form of the catalog item «New server»'])
    expect(out.sites.get('test')).toEqual(['the form of the catalog item «New server»'])
    // Every read is the tenant's; the table column read names its field and column.
    for (const c of g.calls) expect(c.params['tenantId']).toBe('t1')
    expect(g.calls.find((c) => c.cypher.includes('FORM_TABLE_ROW'))!.params).toMatchObject({ field: 'righe', column: 'env' })
  })

  it('a vocabulary no form field uses costs one read and names nothing', async () => {
    const g = fakeGraph(() => [])
    const out = await formValueReferences(g as never, 't1', 'priority', ['high'])
    expect(out.records.size).toBe(0)
    expect(out.sites.size).toBe(0)
    expect(g.calls).toHaveLength(1)
  })
})

describe('replaceInForms', () => {
  it('rewrites the answers, the cells, the form and its revisions — and only the rules on the vocabulary\'s fields', async () => {
    const written: Row[] = []
    const g = fakeGraph((cypher, params) => {
      const lib = library(cypher)
      if (lib) return lib
      if (cypher.includes('SET s[$prop] = $to')) return [{ n: int(5) }]
      if (cypher.includes('SET s[$prop] = reduce')) return [{ n: int(2) }]
      if (cypher.includes('SET r[$column] = $to')) return [{ n: int(1) }]
      if (cypher.includes('UNION ALL')) return [
        { kind: 'item', id: 'item-1', revision: null, raw: JSON.stringify(FORM) },
        { kind: 'revision', id: 'item-1', revision: int(2), raw: JSON.stringify(FORM) },
        { kind: 'item', id: 'item-2', revision: null, raw: JSON.stringify({ version: 1, sections: [] }) },
      ]
      if (cypher.includes('SET i.form') || cypher.includes('SET r.definition')) written.push({ cypher, ...params })
      return []
    })
    const touched = await replaceInForms({ run: g.run } as never, 't1', 'environment', 'produzione', 'prod')
    // Records only: 5 answers, 2 multiple choices, 1 table row.
    expect(touched).toBe(8)
    expect(written.map((w) => [w['id'], w['revision'] ?? null])).toEqual([['item-1', null], ['item-1', int(2)]])
    const doc = JSON.parse(String(written[0]!['doc'])) as typeof FORM
    expect(doc.sections[0]!.items[0]).toEqual({ field: 'ambiente', defaultValue: 'prod' })
    expect(doc.sections[0]!.items[1]!.visibleWhen!.rules).toEqual([
      { field: 'ambiente', op: 'eq', value: 'prod' },
      // Another field's rule keeps its text, even when it is the same word.
      { field: 'costo', op: 'gt', value: 'produzione' },
    ])
    expect(doc.sections[0]!.visibleWhen.rules[0]).toEqual({ field: 'ambiente', op: 'ne', value: 'test' })
    // A multiple choice keeps one of each: a request that had both keeps the new one once.
    expect(g.calls.find((c) => c.cypher.includes('SET s[$prop] = reduce'))!.cypher).toContain('CASE WHEN v IN acc THEN acc ELSE acc + v END')
  })

  it('no form field on the vocabulary: nothing is read beyond the library, nothing written', async () => {
    const g = fakeGraph(() => [])
    await expect(replaceInForms({ run: g.run } as never, 't1', 'priority', 'high', 'alta')).resolves.toBe(0)
    expect(g.calls).toHaveLength(1)
  })
})
