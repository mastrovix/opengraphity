export function standardChangeCatalogSDL(): string {
  return `#graphql

  type ChangeCatalogCategory {
    id: ID!
    name: String!
    description: String
    icon: String
    color: String
    order: Int!
    enabled: Boolean!
    entryCount: Int!
  }

  type StandardChangeCatalogEntry {
    id: ID!
    name: String!
    description: String!
    category: ChangeCatalogCategory
    categoryId: String!
    riskLevel: String!
    impact: String!
    defaultTitleTemplate: String!
    defaultDescriptionTemplate: String!
    defaultPriority: String!
    ciTypes: [String!]
    checklist: String
    estimatedDurationHours: Float
    requiresDowntime: Boolean!
    rollbackProcedure: String
    icon: String
    color: String
    usageCount: Int!
    enabled: Boolean!
    createdBy: String
    createdAt: String!
    updatedAt: String!
  }
  `
}
