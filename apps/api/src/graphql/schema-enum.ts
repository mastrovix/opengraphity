export function enumTypeSDL(): string {
  return `
  type EnumTypeDefinition {
    id:        ID!
    tenantId:  String!
    name:      String!
    label:     String!
    values:    [String!]!
    isSystem:  Boolean!
    scope:     String!
    createdAt: String!
    updatedAt: String!
  }

  input CreateEnumTypeInput {
    name:   String!
    label:  String!
    values: [String!]!
    scope:  String!
  }

  input UpdateEnumTypeInput {
    label:  String
    values: [String!]
    scope:  String
  }
  `
}
