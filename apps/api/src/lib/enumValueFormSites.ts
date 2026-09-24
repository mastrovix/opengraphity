/**
 * WHERE THE CATALOG FORMS KEEP DICTIONARY VALUES (review of 23 Sep 2026).
 *
 * The count and the rename of a vocabulary value (`enumValueUsage.ts`) looked
 * at the CI fields, the domain bindings, the matrices and the rule sites —
 * never at the catalog forms. A form field of the tenant's library names a
 * vocabulary (`FormField.vocabulary`), and its values then live in four places:
 *  - the ANSWERS, stored on the request under the field's name (a list for
 *    `multi_enum`);
 *  - the CELLS of a table field, on the `FormTableRow` nodes of the request,
 *    for the columns that name the vocabulary;
 *  - the CONDITIONS (`visibleWhen`) of the forms, whose rules on that field
 *    compare with a value;
 *  - the DEFAULTS (`defaultValue`) of the form items on that field.
 * Renaming `produzione` → `prod` left `visibleWhen: ambiente eq produzione`
 * behind: the required CAB approval it guarded was never asked again, and the
 * count said «no uses», so a removal went through too.
 *
 * The published revisions (`CatalogFormRevision`) are rewritten with the
 * form: an old request is read with its revision, and after the rename its
 * answers carry the new value — a condition on the old one would hide what
 * was answered. They are not counted: they follow the form and the answers.
 */
import type { ManagedTransaction, Session } from 'neo4j-driver'
import { toNumber } from '@opengraphity/neo4j'
import { FORM_FIELD_TYPES_MULTI, type FormFieldType } from '@opengraphity/types'

type Row = Record<string, unknown>
type Queryable = Session | ManagedTransaction

/** The fields and table columns of the tenant's library that take their values from this vocabulary. */
interface FormVocabularySites {
  /** Fields answered with a value of the vocabulary (`multi` = a list of them). */
  answerFields: { name: string; multi: boolean }[]
  /** Table columns with the vocabulary: the cells of `field` under `column`. */
  tableColumns: { field: string; column: string }[]
}

async function formVocabularySites(q: Queryable, tenantId: string, vocabularyName: string): Promise<FormVocabularySites> {
  const fields = await run(q, `
    MATCH (f:FormField {tenant_id: $tenantId})
    WHERE f.vocabulary = $vocabulary OR f.table_definition IS NOT NULL
    RETURN f.name AS name, f.field_type AS fieldType, f.vocabulary AS vocabulary, f.table_definition AS tableDefinition
  `, { tenantId, vocabulary: vocabularyName })
  const out: FormVocabularySites = { answerFields: [], tableColumns: [] }
  for (const f of fields) {
    const name = String(f['name'])
    if (f['vocabulary'] === vocabularyName) {
      out.answerFields.push({ name, multi: FORM_FIELD_TYPES_MULTI.includes(String(f['fieldType']) as FormFieldType) })
    }
    for (const column of tableColumnsOf(f['tableDefinition'])) {
      if (column.vocabulary === vocabularyName) out.tableColumns.push({ field: name, column: column.name })
    }
  }
  return out
}

/**
 * The uses of each of `values` in the catalog forms: the answers and the table
 * cells as RECORDS (per field), the conditions and defaults as configuration
 * sites (per catalog item).
 */
export async function formValueReferences(
  q: Queryable, tenantId: string, vocabularyName: string, values: readonly string[],
): Promise<{ records: Map<string, { fieldName: string; typeName: string; count: number }[]>; sites: Map<string, string[]> }> {
  const records = new Map<string, { fieldName: string; typeName: string; count: number }[]>()
  const sites = new Map<string, string[]>()
  const found = await formVocabularySites(q, tenantId, vocabularyName)
  if (found.answerFields.length === 0 && found.tableColumns.length === 0) return { records, sites }
  const addRecord = (value: string, typeName: string, fieldName: string, count: number): void => {
    if (count === 0) return
    records.set(value, [...(records.get(value) ?? []), { typeName, fieldName, count }])
  }

  for (const field of found.answerFields) {
    const rows = await run(q, field.multi
      ? `MATCH (s:ServiceRequest {tenant_id: $tenantId})
         WHERE s[$prop] IS NOT NULL
         UNWIND s[$prop] AS value
         WITH value WHERE value IN $values
         RETURN value, count(*) AS n`
      : `MATCH (s:ServiceRequest {tenant_id: $tenantId})
         WHERE s[$prop] IN $values
         RETURN s[$prop] AS value, count(*) AS n`,
    { tenantId, prop: field.name, values: [...values] })
    for (const r of rows) addRecord(String(r['value']), 'ServiceRequest', field.name, toNumber(r['n']))
  }
  for (const t of found.tableColumns) {
    const rows = await run(q, `
      MATCH (:ServiceRequest {tenant_id: $tenantId})-[:FORM_TABLE_ROW {field: $field}]->(r:FormTableRow {tenant_id: $tenantId})
      WHERE r[$column] IN $values
      RETURN r[$column] AS value, count(*) AS n
    `, { tenantId, field: t.field, column: t.column, values: [...values] })
    for (const r of rows) addRecord(String(r['value']), 'FormTableRow', `${t.field}.${t.column}`, toNumber(r['n']))
  }

  const fieldNames = new Set(found.answerFields.map((f) => f.name))
  if (fieldNames.size > 0) {
    const wanted = new Set(values)
    const forms = await run(q, `
      MATCH (i:ServiceCatalogItem {tenant_id: $tenantId})
      WHERE i.form IS NOT NULL
      RETURN i.name AS name, i.form AS form
    `, { tenantId })
    for (const row of forms) {
      const doc = parseForm(row['form'])
      if (!doc) continue
      for (const value of valuesNamedInForm(doc, fieldNames)) {
        if (!wanted.has(value)) continue
        const where = `the form of the catalog item «${String(row['name'])}»`
        const list = sites.get(value) ?? []
        if (!list.includes(where)) list.push(where)
        sites.set(value, list)
      }
    }
  }
  return { records, sites }
}

/**
 * Rewrites `from` → `to` in the answers, the table cells, the forms and their
 * published revisions, in the caller's transaction. Returns how many RECORDS
 * (answers and rows) it touched — the forms are configuration.
 */
export async function replaceInForms(
  tx: ManagedTransaction, tenantId: string, vocabularyName: string, from: string, to: string,
): Promise<number> {
  const sites = await formVocabularySites(tx, tenantId, vocabularyName)
  let touched = 0
  for (const field of sites.answerFields) {
    const rows = await run(tx, field.multi
      ? `MATCH (s:ServiceRequest {tenant_id: $tenantId})
         WHERE s[$prop] IS NOT NULL AND $from IN s[$prop]
         WITH s, [v IN s[$prop] | CASE WHEN v = $from THEN $to ELSE v END] AS renamed
         // One choice once: a request that had both keeps the new one, not two of it.
         SET s[$prop] = reduce(acc = [], v IN renamed | CASE WHEN v IN acc THEN acc ELSE acc + v END)
         RETURN count(*) AS n`
      : `MATCH (s:ServiceRequest {tenant_id: $tenantId})
         WHERE s[$prop] = $from
         SET s[$prop] = $to
         RETURN count(*) AS n`,
    { tenantId, prop: field.name, from, to })
    for (const r of rows) touched += toNumber(r['n'])
  }
  for (const t of sites.tableColumns) {
    const rows = await run(tx, `
      MATCH (:ServiceRequest {tenant_id: $tenantId})-[:FORM_TABLE_ROW {field: $field}]->(r:FormTableRow {tenant_id: $tenantId})
      WHERE r[$column] = $from
      SET r[$column] = $to
      RETURN count(*) AS n
    `, { tenantId, field: t.field, column: t.column, from, to })
    for (const r of rows) touched += toNumber(r['n'])
  }

  const fieldNames = new Set(sites.answerFields.map((f) => f.name))
  if (fieldNames.size === 0) return touched
  const documents = await run(tx, `
    MATCH (i:ServiceCatalogItem {tenant_id: $tenantId})
    WHERE i.form IS NOT NULL
    RETURN 'item' AS kind, i.id AS id, null AS revision, i.form AS raw
    UNION ALL
    MATCH (r:CatalogFormRevision {tenant_id: $tenantId})
    RETURN 'revision' AS kind, r.item_id AS id, r.revision AS revision, r.definition AS raw
  `, { tenantId })
  for (const d of documents) {
    const doc = parseForm(d['raw'])
    if (!doc || !rewriteFormValues(doc, fieldNames, from, to)) continue
    await run(tx, d['kind'] === 'item'
      ? 'MATCH (i:ServiceCatalogItem {id: $id, tenant_id: $tenantId}) SET i.form = $doc'
      : 'MATCH (r:CatalogFormRevision {tenant_id: $tenantId, item_id: $id, revision: $revision}) SET r.definition = $doc',
    { tenantId, id: d['id'], revision: d['revision'], doc: JSON.stringify(doc) })
  }
  return touched
}

// ── The form document ──────────────────────────────────────────────────────
// Read loosely on purpose: a form that does not parse is the form's own
// problem (the health page names it), and must not stop a dictionary change.

interface LooseRule { field?: unknown; value?: unknown }
interface LooseCondition { rules?: unknown }
interface LooseItem { field?: unknown; defaultValue?: unknown; visibleWhen?: LooseCondition }
interface LooseSection { items?: unknown; visibleWhen?: LooseCondition }
interface LooseForm { sections?: unknown }

function parseForm(raw: unknown): LooseForm | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as LooseForm : null
  } catch { return null }
}

const listOf = <T>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x === 'object') as T[] : [])

/** Every value the form names for one of `fieldNames`: in a condition rule or as a default. */
function valuesNamedInForm(form: LooseForm, fieldNames: ReadonlySet<string>): string[] {
  const out: string[] = []
  const rulesOf = (c: LooseCondition | undefined): void => {
    for (const rule of listOf<LooseRule>(c?.rules)) {
      if (typeof rule.field === 'string' && fieldNames.has(rule.field) && typeof rule.value === 'string') out.push(rule.value)
    }
  }
  for (const section of listOf<LooseSection>(form.sections)) {
    rulesOf(section.visibleWhen)
    for (const item of listOf<LooseItem>(section.items)) {
      rulesOf(item.visibleWhen)
      if (typeof item.field === 'string' && fieldNames.has(item.field) && typeof item.defaultValue === 'string') out.push(item.defaultValue)
    }
  }
  return out
}

/** Rewrites the values in place; true when something changed. */
function rewriteFormValues(form: LooseForm, fieldNames: ReadonlySet<string>, from: string, to: string): boolean {
  let changed = false
  const rulesOf = (c: LooseCondition | undefined): void => {
    for (const rule of listOf<LooseRule>(c?.rules)) {
      if (typeof rule.field === 'string' && fieldNames.has(rule.field) && rule.value === from) { rule.value = to; changed = true }
    }
  }
  for (const section of listOf<LooseSection>(form.sections)) {
    rulesOf(section.visibleWhen)
    for (const item of listOf<LooseItem>(section.items)) {
      rulesOf(item.visibleWhen)
      if (typeof item.field === 'string' && fieldNames.has(item.field) && item.defaultValue === from) { item.defaultValue = to; changed = true }
    }
  }
  return changed
}

function tableColumnsOf(raw: unknown): { name: string; vocabulary: string | null }[] {
  if (typeof raw !== 'string' || raw === '') return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  const columns = (parsed as { columns?: unknown } | null)?.columns
  return listOf<{ name?: unknown; vocabulary?: unknown }>(columns)
    .filter((c) => typeof c.name === 'string')
    .map((c) => ({ name: c.name as string, vocabulary: typeof c.vocabulary === 'string' ? c.vocabulary : null }))
}

async function run(q: Queryable, cypher: string, params: Record<string, unknown>): Promise<Row[]> {
  const asSession = q as Session
  const res = typeof asSession.executeRead === 'function'
    ? await asSession.executeRead((tx) => tx.run(cypher, params))
    : await (q as ManagedTransaction).run(cypher, params)
  return res.records.map((rec) => Object.fromEntries(rec.keys.map((k) => [String(k), rec.get(k)])) as Row)
}
