import { getSession } from '@opengraphity/neo4j'
import type { CITypeWithDefinitions, CIFieldDefinition, CIRelationDefinition, CISystemRelationDefinition } from './types.js'

export async function loadMetamodel(tenantId: string): Promise<CITypeWithDefinitions[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:CITypeDefinition)
        WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))
          AND t.active = true
        OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
          WHERE f.scope = 'base' OR (f.scope = 'tenant' AND f.tenant_id = $tenantId)
        OPTIONAL MATCH (t)-[:HAS_RELATION]->(r:CIRelationDefinition)
        OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
        RETURN t,
          collect(DISTINCT f) AS fields,
          collect(DISTINCT r) AS relations,
          collect(DISTINCT sr) AS systemRelations
        ORDER BY t.name
      `, { tenantId }),
    )

    return result.records.map(record => {
      const t = record.get('t').properties as Record<string, unknown>

      const fields = (record.get('fields') as Array<{ properties: Record<string, unknown> }>)
        .filter(f => f && f.properties)
        .map(f => mapField(f.properties))
        .sort((a, b) => a.order - b.order)

      const relations = (record.get('relations') as Array<{ properties: Record<string, unknown> }>)
        .filter(r => r && r.properties)
        .map(r => mapRelation(r.properties))
        .sort((a, b) => a.order - b.order)

      const systemRelations = (record.get('systemRelations') as Array<{ properties: Record<string, unknown> }>)
        .filter(sr => sr && sr.properties)
        .map(sr => mapSystemRelation(sr.properties))
        .sort((a, b) => a.order - b.order)

      return {
        id:           t['id'] as string,
        name:         t['name'] as string,
        label:        t['label'] as string,
        icon:         t['icon'] as string,
        color:        t['color'] as string,
        scope:        t['scope'] as 'base' | 'tenant',
        tenantId:     t['tenant_id'] as string,
        active:       t['active'] as boolean,
        neo4jLabel:   t['neo4j_label'] as string,
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
    id:           f['id'] as string,
    name:         f['name'] as string,
    label:        f['label'] as string,
    fieldType:    f['field_type'] as CIFieldDefinition['fieldType'],
    required:     (f['required'] as boolean) ?? false,
    defaultValue: (f['default_value'] as string | null) ?? null,
    enumValues:   f['enum_values'] ? JSON.parse(f['enum_values'] as string) as string[] : [],
    order:        (f['order'] as number) ?? 0,
    scope:        f['scope'] as 'base' | 'tenant',
    tenantId:     f['tenant_id'] as string,
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
    order:            (r['order'] as number) ?? 0,
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
    order:            (sr['order'] as number) ?? 0,
  }
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
      .filter(f => !BASE_TYPE_FIELDS.has(f.name))
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
    return `  ${pluralKey}(limit: Int, offset: Int, status: String, environment: String, search: String): ${typeName}sResult!
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
      .filter(f => !BASE_INPUT_FIELDS.has(f.name))
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
}

input CIFieldInput {
  name: String!
  label: String!
  fieldType: String!
  required: Boolean
  defaultValue: String
  enumValues: [String!]
  order: Int
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

function toPascalCase(str: string): string {
  return str.split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

function pluralize(str: string): string {
  if (str.endsWith('s')) return str + 'es'
  if (str.endsWith('y')) return str.slice(0, -1) + 'ies'
  return str + 's'
}

function graphqlFieldType(fieldType: string): string {
  switch (fieldType) {
    case 'number':  return 'Float'
    case 'boolean': return 'Boolean'
    case 'date':    return 'String'
    default:        return 'String'
  }
}
