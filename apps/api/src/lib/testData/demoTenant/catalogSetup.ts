/**
 * THE CATALOG, BUILT WITH THE APP'S OWN DESIGNER (23 Sep 2026).
 *
 * The owner of the product asked for request models "created with the
 * designer". So nothing here writes a catalog node by hand: the vocabularies
 * go through the Dictionary's `createEnumType`, the fields through the
 * library's `createFormField`, the models through `createServiceCatalogItem`
 * and the forms through `saveCatalogForm` — every validation of the designer
 * runs, and a form it would refuse stops the generator. Called as an
 * administrator of the tenant; the dates and the demo mark are set afterwards
 * (`backdate`), because the mutations stamp "now".
 *
 * Most fields belong to one model, and five are shared by several (D26): the
 * library needs room for all of them, so its limit is raised first with the
 * same mutation the settings page uses. Every vocabulary gets its labels in
 * English and Italian (D54), the shipped `category` vocabulary is customized
 * with the categories the catalog needs (D28), and every model gets its
 * fulfilment group (D56).
 */
import { runQuery, getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../auth/resolveAuth.js'
import { createEnumType, customizeEnumType, updateEnumType } from '../../../graphql/resolvers/enumType.js'
import { catalogFormResolvers } from '../../../graphql/resolvers/catalogForm.js'
import { serviceRequestResolvers } from '../../../graphql/resolvers/service_request.js'
import { LINGUE, parseValueLabels } from '../../enumValueLabels.js'
import { CATALOG_CATEGORIES, DEMO_CATALOG, DEMO_VOCABULARIES, vocabularyValues, type DemoCatalogItemSpec, type DemoFieldSpec } from './catalogContent.js'
import type { PlannedTeam } from './people.js'

export interface BuiltField {
  name: string
  spec: DemoFieldSpec
}

export interface BuiltCatalogItem {
  id: string
  spec: DemoCatalogItemSpec
  revision: number
  fields: BuiltField[]
  vocabularyIds: string[]
  /** The team that takes its requests when they are created (D56). */
  fulfilmentTeamId: string
}

export interface BuiltCatalog {
  items: BuiltCatalogItem[]
  vocabularyIds: string[]
  fieldIds: string[]
  /**
   * The calls that write no Audit Log entry of their own: in a request, the
   * app's mutation registry writes `mutation.<name>` for them. Called
   * directly, nothing does — the generator writes those rows afterwards.
   */
  registry: Array<{ mutation: string; returnType: string; args: Record<string, unknown>; result: unknown }>
}

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: GraphQLContext) => Promise<unknown>
const mutation = (name: string): Resolver => {
  const fromForm = (catalogFormResolvers.Mutation as unknown as Record<string, Resolver>)[name]
  const fromRequests = (serviceRequestResolvers.Mutation as unknown as Record<string, Resolver>)[name]
  const r = fromForm ?? fromRequests
  if (!r) throw new Error(`catalogSetup: mutation ${name} not found`)
  return r
}

export function fieldName(item: DemoCatalogItemSpec, field: DemoFieldSpec): string {
  return field.shared ? field.key : `${item.key}_${field.key}`
}

/** The library name of the field of `item` whose key is `key` (a condition points at it). */
function fieldNameOfKey(item: DemoCatalogItemSpec, key: string): string {
  const f = item.sections.flatMap((s) => s.fields).find((x) => x.key === key)
  if (!f) throw new Error(`demo catalog "${item.name}": a condition points at "${key}", which is not in the form`)
  return fieldName(item, f)
}

/**
 * THE FULFILMENT GROUP OF A MODEL (D56): the global team of its tower — the
 * group that takes the requests of the whole company and dispatches the ones
 * done on site. A smaller tenant may lack it: then a team of the tower, then
 * the service desk. No support team at all is an error.
 */
export function fulfilmentTeamFor(teams: readonly PlannedTeam[], tower: string): PlannedTeam {
  const support = teams.filter((t) => t.type === 'support' && !t.isChangeManager)
  const ofTower = support.filter((t) => t.area === tower).sort((a, b) => a.name.localeCompare(b.name))
  const team = ofTower.find((t) => t.region === 'Global') ?? ofTower[0]
    ?? support.filter((t) => t.area === 'Service Desk').sort((a, b) => a.name.localeCompare(b.name))[0] ?? support[0]
  if (!team) throw new Error('demo catalog: there is no support team to fulfil the requests')
  return team
}

/**
 * The form document the designer saves: sections with titles in both
 * languages, and the revision it was loaded at (0 for a new form: the
 * designer sends it back and the server publishes revision + 1).
 */
export function formDefinition(item: DemoCatalogItemSpec, revision = 0): Record<string, unknown> {
  return {
    version: 1,
    revision,
    sections: item.sections.map((sec) => ({
      id: sec.id,
      title: { en: sec.title, it: sec.titleIt },
      ...(sec.columns ? { columns: sec.columns } : {}),
      items: sec.fields.map((f) => ({
        field: fieldName(item, f),
        ...(f.required ? { required: true } : {}),
        ...(f.width ? { width: f.width } : {}),
        ...(f.agentOnly ? { endUser: false } : {}),
        ...(f.visibleWhen ? { visibleWhen: { match: 'all', rules: [{
          field: fieldNameOfKey(item, f.visibleWhen.field), op: f.visibleWhen.op,
          ...(f.visibleWhen.value !== undefined ? { value: f.visibleWhen.value } : {}),
        }] } } : {}),
      })),
    })),
  }
}

/**
 * The vocabularies, each with its labels in the two languages of the product.
 * `valueLabels` REPLACES the labels (updateEnumType): the list sent is the
 * whole list.
 */
async function buildVocabularies(ctx: GraphQLContext): Promise<string[]> {
  const ids: string[] = []
  for (const v of DEMO_VOCABULARIES) {
    const created = await createEnumType(null, { input: { name: v.name, label: v.label, values: vocabularyValues(v), scope: 'itil' } }, ctx) as { id: string }
    await updateEnumType(null, { id: created.id, input: { valueLabels: v.entries.flatMap(([value, it]) => [
      { value, language: 'en', label: value }, { value, language: 'it', label: it },
    ]) } }, ctx)
    ids.push(created.id)
  }
  return ids
}

/**
 * D28: the categories the catalog needs, added to the tenant's copy of the
 * shipped `category` vocabulary (customizeEnumType), with the labels of the
 * shipped values kept and the new ones written. Returns the copy's id — the
 * clean-up removes it, and the tenant reads the shipped one again.
 */
async function customizeCategories(ctx: GraphQLContext): Promise<string> {
  const session = getSession()
  let shipped: { id: string; values: string[]; labels: unknown } | undefined
  try {
    shipped = (await runQuery<{ id: string; values: string[]; labels: unknown }>(session, `
      MATCH (e:EnumTypeDefinition {tenant_id: 'system', name: 'category'})
      RETURN e.id AS id, e.values AS values, e.value_labels AS labels`, {}))[0]
  } finally {
    await session.close()
  }
  if (!shipped) throw new Error('demo catalog: the shipped "category" vocabulary does not exist')
  const copy = await customizeEnumType(null, { id: shipped.id }, ctx) as { id: string }
  const kept = parseValueLabels(shipped.labels).labels
  const values = [...shipped.values, ...CATALOG_CATEGORIES.map(([v]) => v).filter((v) => !shipped.values.includes(v))]
  await updateEnumType(null, { id: copy.id, input: { values, valueLabels: [
    ...Object.entries(kept).flatMap(([value, per]) => LINGUE.flatMap((language) => (per[language] ? [{ value, language, label: per[language] }] : []))),
    ...CATALOG_CATEGORIES.flatMap(([value, en, it]) => [{ value, language: 'en', label: en }, { value, language: 'it', label: it }]),
  ], valueIcons: CATALOG_CATEGORIES.map(([value, , , icon]) => ({ value, icon })) } }, ctx)
  return copy.id
}

export async function buildCatalog(ctx: GraphQLContext, workflowDefinitionId: string | null, teams: readonly PlannedTeam[]): Promise<BuiltCatalog> {
  const registry: BuiltCatalog['registry'] = []
  const call = async (name: string, returnType: string, args: Record<string, unknown>, ownAudit: boolean): Promise<unknown> => {
    const result = await mutation(name)(null, args, ctx)
    if (!ownAudit) registry.push({ mutation: name, returnType, args, result })
    return result
  }
  const vocabularyIds = await buildVocabularies(ctx)
  vocabularyIds.push(await customizeCategories(ctx))

  // Room in the library: every field once, the shared ones included once.
  const libraryNames = new Set(DEMO_CATALOG.flatMap((it) => it.sections.flatMap((s) => s.fields.map((f) => fieldName(it, f)))))
  await call('setCatalogFormLimits', 'CatalogFormLimits!', { maxLibraryFields: Math.max(120, Math.ceil((libraryNames.size + 20) / 50) * 50), maxFieldsPerForm: 60, maxTableRows: 50 }, false)

  const items: BuiltCatalogItem[] = []
  const fieldIds: string[] = []
  const created = new Set<string>()
  for (const spec of DEMO_CATALOG) {
    const fields: BuiltField[] = []
    for (const sec of spec.sections) {
      for (const f of sec.fields) {
        const name = fieldName(spec, f)
        fields.push({ name, spec: f })
        if (created.has(name)) continue
        created.add(name)
        const field = await call('createFormField', 'FormField!', { input: {
          name, fieldType: f.type, label: f.label,
          labels: [{ language: 'it', text: f.labelIt }],
          help: f.help ?? null,
          required: false,
          vocabulary: f.vocabulary ?? null,
          inList: f.inList === true && !['ref_ci', 'ref_user', 'table', 'note'].includes(f.type),
          refTypes: f.refTypes ?? null,
          tableDefinition: f.table ? JSON.stringify({
            version: 1,
            columns: f.table.map((c) => ({ name: c.name, labels: { en: c.label, it: c.labelIt }, fieldType: c.type, ...(c.vocabulary ? { vocabulary: c.vocabulary } : {}), ...(c.required ? { required: true } : {}) })),
          }) : null,
        } }, false) as { id: string }
        fieldIds.push(field.id)
      }
    }
    const fulfilmentTeamId = fulfilmentTeamFor(teams, spec.fulfilTower).id
    const item = await call('createServiceCatalogItem', 'ServiceCatalogItem!', { input: {
      name: spec.name, description: spec.description, category: spec.category, requiresApproval: spec.requiresApproval,
      priority: spec.priority, workflowDefinitionId, fulfillmentTeamId: fulfilmentTeamId,
    } }, true) as { id: string }
    const saved = await call('saveCatalogForm', 'CatalogForm!', { itemId: item.id, definition: JSON.stringify(formDefinition(spec)) }, false) as { revision: number }
    items.push({ id: item.id, spec, revision: saved.revision, fields, vocabularyIds: [], fulfilmentTeamId })
  }
  return { items, vocabularyIds, fieldIds, registry }
}
