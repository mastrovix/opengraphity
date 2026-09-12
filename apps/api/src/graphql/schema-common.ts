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
    chain: String
    createdAt: String!
    updatedAt: String
    notes: String
    ownerGroup: Team
    supportGroup: Team
    """Salute dal monitoraggio (Event Management): operational | degraded | down. Null finché nessun evento ha riguardato il CI. Sola lettura."""
    health: String
    """monitoring | manual (forzatura da setCIHealthOverride)."""
    healthSource: String
    lastEventAt: String
  }

  type AllCIsResult { items: [CIBase!]!, total: Int! }
  # items è troncato a MEMBERS_LIMIT per i gruppi dinamici; total è il conteggio reale.
  type CIGroupMembersResult { items: [CIBase!]!, total: Int!, truncated: Boolean! }
  type BlastRadiusItem { ci: CIBase!, distance: Int!, parentId: String }

  # ── Metamodel types ──────────────────────────────────────────────────────────

  type CITypeDefinition {
    id: ID!
    name: String!
    label: String!
    icon: String
    color: String
    active: Boolean!
    """base | itil | tenant. I tipi \`base\` e \`itil\` sono spediti col prodotto: UN nodo per tutti i clienti, in sola lettura. Senza questo campo il disegnatore offriva azioni che non scrivevano niente (A-6)."""
    scope: String!
    """Il cliente proprietario del tipo: \`system\` per quelli spediti col prodotto."""
    tenantId: String!
    validationScript: String
    chainFamilies: [String!]!
    """Ruolo del tipo nella mappa di un servizio: component | infrastructure | certificate. \`null\` = non dichiarato, il ruolo lo propone il prodotto (seme dei tipi spediti, poi le famiglie di catena)."""
    serviceRole: String
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
    enumTypeId:   ID
    enumTypeName: String
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
    name:             String!
    label:            String!
    fieldType:        String!
    required:         Boolean
    enumValues:       [String!]
    enumTypeId:       ID
    order:            Int
    validationScript: String
    visibilityScript: String
    defaultScript:    String
  }

  input UpdateITILTypeInput {
    label:            String
    icon:             String
    color:            String
    validationScript: String
  }

  # ── ITIL-CI Relation Rules ───────────────────────────────────────────────────

  type ITILCIRelationRule {
    id:           ID!
    itilType:     String!
    ciType:       String!
    relationType: String!
    direction:    String!
    description:  String
  }

  input UpdateCIFieldsInput {
    name: String
    status: String
    environment: String
    description: String
    notes: String
    customFields: String
  }

  input CreateTeamInput {
    name: String!
    description: String
  }
  `
}
