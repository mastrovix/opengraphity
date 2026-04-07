import { getSession } from '@opengraphity/neo4j'
import type { CITypeWithDefinitions, CIFieldDefinition, CIRelationDefinition, CISystemRelationDefinition } from './types.js'
import { toPascalCase, pluralize } from './stringUtils.js'

export async function loadMetamodel(tenantId: string): Promise<CITypeWithDefinitions[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition)
        WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))
          AND t.active = true
          AND t.name <> '__base__'
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
          WHERE f.scope = 'base' OR (f.scope = 'tenant' AND f.tenant_id = $tenantId)
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(r:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        OPTIONAL MATCH (base:CITypeDefinition {name: '__base__'})
          WHERE base.tenant_id = $tenantId OR base.tenant_id = 'system'
        OPTIONAL MATCH (base)-[:HAS_FIELD]->(bf:CIFieldDefinition)
        RETURN t,
          collect(DISTINCT f)  AS typeFields,
          collect(DISTINCT bf) AS baseFields,
          collect(DISTINCT r)  AS relations,
          collect(DISTINCT sr) AS systemRelations
        ORDER BY t.name
      `, { tenantId }),
    )

    return result.records.map(record => {
      const t = record.get('t').properties as Record<string, unknown>

      const typeFields = (record.get('typeFields') as Array<{ properties: Record<string, unknown> }>)
        .filter(f => f && f.properties)
        .map(f => mapField(f.properties))

      const baseFields = (record.get('baseFields') as Array<{ properties: Record<string, unknown> }>)
        .filter(f => f && f.properties)
        .map(f => mapField(f.properties))

      // Merge: base fields first, then type-specific; deduplicate by name
      const seen = new Set<string>()
      const fields = [...baseFields, ...typeFields]
        .sort((a, b) => a.order - b.order)
        .filter(f => { if (seen.has(f.name)) return false; seen.add(f.name); return true })

      const relations = (record.get('relations') as Array<{ properties: Record<string, unknown> }>)
        .filter(r => r && r.properties)
        .map(r => mapRelation(r.properties))
        .sort((a, b) => a.order - b.order)

      const systemRelations = (record.get('systemRelations') as Array<{ properties: Record<string, unknown> }>)
        .filter(sr => sr && sr.properties)
        .map(sr => mapSystemRelation(sr.properties))
        .sort((a, b) => a.order - b.order)


      return {
        id:               t['id'] as string,
        name:             t['name'] as string,
        label:            t['label'] as string,
        icon:             t['icon'] as string,
        color:            t['color'] as string,
        scope:            t['scope'] as 'base' | 'tenant',
        tenantId:         t['tenant_id'] as string,
        active:           t['active'] as boolean,
        neo4jLabel:       t['neo4j_label'] as string,
        validationScript: (t['validation_script'] as string | null) ?? null,
        fields,
        relations,
        systemRelations,
      }
    })
  } finally {
    await session.close()
  }
}

function mapField(f: Record<string, unknown>): CIFieldDefinition {
  return {
    id:               f['id'] as string,
    name:             f['name'] as string,
    label:            f['label'] as string,
    fieldType:        f['field_type'] as CIFieldDefinition['fieldType'],
    required:         (f['required'] as boolean) ?? false,
    defaultValue:     (f['default_value'] as string | null) ?? null,
    enumValues:       f['enum_values'] ? JSON.parse(f['enum_values'] as string) as string[] : [],
    order:            Number(f['order'] ?? 0),
    scope:            f['scope'] as 'base' | 'tenant',
    tenantId:         f['tenant_id'] as string,
    validationScript: (f['validation_script'] as string | null) ?? null,
    visibilityScript: (f['visibility_script'] as string | null) ?? null,
    defaultScript:    (f['default_script']    as string | null) ?? null,
    isSystem:         (f['is_system']         as boolean)       ?? false,
  }
}

function mapRelation(r: Record<string, unknown>): CIRelationDefinition {
  return {
    id:               r['id'] as string,
    name:             r['name'] as string,
    label:            r['label'] as string,
    relationshipType: r['relationship_type'] as string,
    targetType:       r['target_type'] as string,
    cardinality:      r['cardinality'] as 'one' | 'many',
    direction:        r['direction'] as 'outgoing' | 'incoming',
    order:            Number(r['order'] ?? 0),
  }
}

function mapSystemRelation(sr: Record<string, unknown>): CISystemRelationDefinition {
  return {
    id:               sr['id'] as string,
    name:             sr['name'] as string,
    label:            sr['label'] as string,
    relationshipType: sr['relationship_type'] as string,
    targetEntity:     sr['target_entity'] as string,
    required:         (sr['required'] as boolean) ?? false,
    order:            Number(sr['order'] ?? 0),
  }
}

// ── ITIL metamodel loader ─────────────────────────────────────────────────────

/**
 * Loads ITIL type definitions (scope: 'itil') from Neo4j.
 * Returns the type+fields needed to generate GraphQL enum definitions.
 */
export async function loadITILTypes(tenantId: string): Promise<CITypeWithDefinitions[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition)
        WHERE t.scope = 'itil'
          AND t.active = true
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
        OPTIONAL MATCH (f)-[:USES_ENUM]->(enumDef:EnumTypeDefinition)
        RETURN t, collect(DISTINCT {props: f, enumTypeId: enumDef.id, enumTypeValues: enumDef.values}) AS fieldData
        ORDER BY t.name
      `, { tenantId }),
    )

    return result.records.map(record => {
      const t = record.get('t').properties as Record<string, unknown>

      type FieldData = { props: { properties: Record<string, unknown> } | null; enumTypeId: string | null; enumTypeValues: string[] | null }
      const rawFieldData = record.get('fieldData') as FieldData[]
      const fields = rawFieldData
        .filter(d => d.props)
        .map(d => {
          const field = mapField(d.props!.properties)
          if (d.enumTypeId && d.enumTypeValues) {
            field.enumValues = d.enumTypeValues
          }
          return field
        })
        .sort((a, b) => a.order - b.order)

      return {
        id:               t['id'] as string,
        name:             t['name'] as string,
        label:            t['label'] as string,
        icon:             (t['icon'] as string) ?? '',
        color:            (t['color'] as string) ?? '',
        scope:            'itil' as const,
        tenantId:         t['tenant_id'] as string,
        active:           t['active'] as boolean,
        neo4jLabel:       (t['neo4j_label'] as string) ?? '',
        validationScript: (t['validation_script'] as string | null) ?? null,
        fields,
        relations:        [],
        systemRelations:  [],
      }
    })
  } finally {
    await session.close()
  }
}

// ── ITIL enum SDL generator ───────────────────────────────────────────────────

/**
 * Generates GraphQL enum definitions from ITIL type fields.
 * Enum name convention: PascalCase(typeName) + PascalCase(fieldName)
 * e.g., incident.status → IncidentStatus, service_request.priority → ServiceRequestPriority
 *
 * Only generates enums — no types, queries, or mutations.
 * The ITIL types themselves are defined as-is in schema-base.ts.
 */
/**
 * Previously generated GraphQL enums from ITIL field definitions.
 * Now returns empty string — all ITIL fields use String type because
 * status values come from configurable workflows and must not be
 * constrained by a fixed enum.
 */
export function generateITILEnumsSDL(_itilTypes: CITypeWithDefinitions[]): string {
  return ''
}

/**
 * Generates SDL for all dynamic CI types.
 * Does NOT re-emit types already defined in schema-base.ts:
 * CIBase, CIRelation, BlastRadiusItem, AllCIsResult, CITypeDefinition, etc.
 *
 * Uses `extend type Query` / `extend type Mutation` to augment the base schema.
 * Generated concrete types use `type` (not `ciType`) to match CIBase interface.
 */
// Fields already present in CIBase / hardcoded in inputs — must not be duplicated
const BASE_TYPE_FIELDS  = new Set(['id', 'name', 'type', 'status', 'environment',
  'description', 'createdAt', 'updatedAt', 'notes',
  'ownerGroup', 'supportGroup', 'dependencies', 'dependents'])
const BASE_INPUT_FIELDS = new Set(['name', 'status', 'environment', 'description',
  'notes', 'ownerGroupId', 'supportGroupId'])

export function generateSDL(types: CITypeWithDefinitions[]): string {
  const parts: string[] = []

  // Concrete type for each CI type
  for (const type of types) {
    const typeName = toPascalCase(type.name)
    const specificFields = type.fields
      .filter(f => !BASE_TYPE_FIELDS.has(f.name) && !f.isSystem)
      .map(f => `  ${f.name}: ${graphqlFieldType(f.fieldType)}${f.required ? '!' : ''}`)
      .join('\n')

    parts.push(`
type ${typeName} implements CIBase {
  id: ID!
  name: String!
  type: String!
  status: String
  environment: String
  description: String
  createdAt: String!
  updatedAt: String
  notes: String
  ownerGroup: Team
  supportGroup: Team
  dependencies: [CIRelation!]!
  dependents: [CIRelation!]!
${specificFields}
}

type ${typeName}sResult {
  items: [${typeName}!]!
  total: Int!
}
`)
  }

  // extend type Query with per-type queries
  const queryFields = types.map(type => {
    const typeName = toPascalCase(type.name)
    const plural = pluralize(typeName)
    const pluralKey = plural.charAt(0).toLowerCase() + plural.slice(1)
    return `  ${pluralKey}(limit: Int, offset: Int, status: String, environment: String, search: String, filters: String, sortField: String, sortDirection: String): ${typeName}sResult!
  ${type.name}(id: ID!): ${typeName}`
  }).join('\n')

  parts.push(`
extend type Query {
${queryFields}
}
`)

  // extend type Mutation with per-type CRUD + input types
  const mutationFields: string[] = []
  const inputTypes: string[] = []

  for (const type of types) {
    const typeName = toPascalCase(type.name)
    const inputFields = type.fields
      .filter(f => !BASE_INPUT_FIELDS.has(f.name) && !f.isSystem)
      .map(f => `  ${f.name}: ${graphqlFieldType(f.fieldType)}${f.required ? '!' : ''}`)
      .join('\n')

    mutationFields.push(
      `  create${typeName}(input: Create${typeName}Input!): ${typeName}!`,
      `  update${typeName}(id: ID!, input: Update${typeName}Input!): ${typeName}!`,
      `  delete${typeName}(id: ID!): Boolean!`,
    )

    inputTypes.push(`
input Create${typeName}Input {
  name: String!
  status: String
  environment: String
  description: String
  notes: String
  ownerGroupId: ID
  supportGroupId: ID
${inputFields}
}

input Update${typeName}Input {
  name: String
  status: String
  environment: String
  description: String
  notes: String
  ownerGroupId: ID
  supportGroupId: ID
${inputFields}
}`)
  }

  parts.push(`
extend type Mutation {
${mutationFields.join('\n')}

  # Metamodello
  createCIType(input: CreateCITypeInput!): CITypeDefinition!
  updateCIType(id: ID!, input: UpdateCITypeInput!): CITypeDefinition!
  deleteCIType(id: ID!): Boolean!
  addCIField(typeId: ID!, input: CIFieldInput!): CITypeDefinition!
  removeCIField(typeId: ID!, fieldId: ID!): CITypeDefinition!
  addCIRelation(typeId: ID!, input: CIRelationInput!): CITypeDefinition!
  removeCIRelation(typeId: ID!, relationId: ID!): CITypeDefinition!
}

input CreateCITypeInput {
  name: String!
  label: String!
  icon: String
  color: String
}

input UpdateCITypeInput {
  label: String
  icon: String
  color: String
  active: Boolean
  validationScript: String
}

input CIFieldInput {
  name: String!
  label: String!
  fieldType: String!
  required: Boolean
  defaultValue: String
  enumTypeId: ID
  order: Int
  validationScript: String
  visibilityScript: String
  defaultScript: String
}

input CIRelationInput {
  name: String!
  label: String!
  relationshipType: String!
  targetType: String!
  cardinality: String!
  direction: String!
  order: Int
}

${inputTypes.join('\n')}
`)

  return parts.join('\n')
}

function graphqlFieldType(fieldType: string): string {
  switch (fieldType) {
    case 'number':  return 'Float'
    case 'boolean': return 'Boolean'
    case 'date':    return 'String'
    default:        return 'String'
  }
}
