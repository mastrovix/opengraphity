export function reportSDL(): string {
  return `
  # ── Custom Report Templates ────────────────────────────────────────────────

  type ReportTemplate {
    id: ID!
    name: String!
    description: String
    icon: String
    visibility: String!
    createdBy: User
    sharedWith: [Team!]!
    sections: [ReportSection!]!
    scheduleEnabled: Boolean!
    scheduleCron: String
    scheduleChannelId: String
    createdAt: String!
    updatedAt: String
  }

  type ReportNode {
    id: ID!
    entityType: String!
    neo4jLabel: String!
    label: String!
    isResult: Boolean!
    isRoot: Boolean!
    positionX: Float!
    positionY: Float!
    filters: String
    selectedFields: [String!]!
  }

  type ReportEdge {
    id: ID!
    sourceNodeId: ID!
    targetNodeId: ID!
    relationshipType: String!
    direction: String!
    label: String!
  }

  type ReportSection {
    id: ID!
    order: Int!
    title: String!
    chartType: String!
    groupByNodeId: String
    groupByField: String
    metric: String!
    metricField: String
    limit: Int
    sortDir: String
    nodes: [ReportNode!]!
    edges: [ReportEdge!]!
  }

  type NavigableEntity {
    entityType: String!
    label: String!
    neo4jLabel: String!
    fields: [NavigableField!]!
    relations: [NavigableRelation!]!
  }

  type NavigableField {
    name: String!
    label: String!
    fieldType: String!
    enumValues: [String!]!
  }

  type NavigableRelation {
    relationshipType: String!
    direction: String!
    label: String!
    targetEntityType: String!
    targetLabel: String!
    targetNeo4jLabel: String!
  }

  type ReachableEntity {
    entityType: String!
    label: String!
    neo4jLabel: String!
    relationshipType: String!
    direction: String!
    count: Int!
    fields: [NavigableField!]!
  }

  type ReportResult {
    sections: [ReportSectionResult!]!
  }

  type ReportSectionResult {
    sectionId: ID!
    title: String!
    chartType: String!
    data: String!
    total: Int
    error: String
  }

  # ── AI Report Conversations ────────────────────────────────────────────────

  type ReportConversation {
    id:        ID!
    title:     String!
    createdAt: String!
    updatedAt: String!
    messages:  [ReportMessage!]!
  }

  type ReportMessage {
    id:        ID!
    role:      String!
    content:   String!
    createdAt: String!
  }

  type AskReportResult {
    message:        ReportMessage!
    conversationId: ID!
  }

  input CreateReportTemplateInput {
    name: String!
    description: String
    icon: String
    visibility: String!
    sharedWithTeamIds: [ID!]
    scheduleEnabled: Boolean
    scheduleCron: String
    scheduleChannelId: String
  }

  input UpdateReportTemplateInput {
    name: String
    description: String
    icon: String
    visibility: String
    sharedWithTeamIds: [ID!]
    scheduleEnabled: Boolean
    scheduleCron: String
    scheduleChannelId: String
  }

  input ReportNodeInput {
    id: String!
    entityType: String!
    neo4jLabel: String!
    label: String!
    isResult: Boolean!
    isRoot: Boolean!
    positionX: Float!
    positionY: Float!
    filters: String
    selectedFields: [String!]
  }

  input ReportEdgeInput {
    id: String!
    sourceNodeId: String!
    targetNodeId: String!
    relationshipType: String!
    direction: String!
    label: String!
  }

  input ReportSectionInput {
    title: String!
    chartType: String!
    groupByNodeId: String
    groupByField: String
    metric: String!
    metricField: String
    limit: Int
    sortDir: String
    nodes: [ReportNodeInput!]!
    edges: [ReportEdgeInput!]!
  }
  `
}
