export function cmdbSDL(): string {
  return `
  # ── CMDB — interface & base types ────────────────────────────────────────────

  type CIRelation {
    ci: CIBase!
    relation: String!
  }

  interface CIBase {
    id: ID!
    name: String!
    type: String
    status: String
    environment: String
    description: String
    createdAt: String!
    updatedAt: String
    notes: String
    ownerGroup: Team
    supportGroup: Team
  }

  type AllCIsResult { items: [CIBase!]!, total: Int! }
  type BlastRadiusItem { ci: CIBase!, distance: Int!, parentId: String }

  # ── Metamodel types ──────────────────────────────────────────────────────────

  type CITypeDefinition {
    id: ID!
    name: String!
    label: String!
    icon: String
    color: String
    active: Boolean!
    validationScript: String
    fields: [CIFieldDef!]!
    relations: [CIRelationDef!]!
    systemRelations: [CISystemRelationDef!]!
  }

  type CIFieldDef {
    id: ID!
    name: String!
    label: String!
    fieldType: String!
    required: Boolean!
    defaultValue: String
    enumValues: [String!]!
    order: Int!
    validationScript: String
    visibilityScript: String
    defaultScript: String
    isSystem: Boolean!
  }

  type CIRelationDef {
    id: ID!
    name: String!
    label: String!
    relationshipType: String!
    targetType: String!
    cardinality: String!
    direction: String!
    order: Int!
  }

  type CISystemRelationDef {
    id: ID!
    name: String!
    label: String!
    relationshipType: String!
    targetEntity: String!
    required: Boolean!
    order: Int!
  }

  input ITILFieldInput {
    name:        String!
    label:       String!
    fieldType:   String!
    required:    Boolean
    enumValues:  [String!]
    order:       Int
  }

  input CreateTeamInput {
    name: String!
    description: String
  }
  `
}
