export const automationSchema = `
  # ── Auto Triggers ───────────────────────────────────────────────────────────

  type AutoTrigger {
    id: ID!
    name: String!
    entityType: String!
    eventType: String!
    conditions: String
    timerDelayMinutes: Int
    actions: String
    enabled: Boolean!
    executionCount: Int!
    lastExecutedAt: String
  }

  input CreateAutoTriggerInput {
    name: String!
    entityType: String!
    eventType: String!
    conditions: String
    timerDelayMinutes: Int
    actions: String
    enabled: Boolean
  }

  input UpdateAutoTriggerInput {
    name: String
    eventType: String
    conditions: String
    timerDelayMinutes: Int
    actions: String
    enabled: Boolean
  }

  # ── Business Rules ─────────────────────────────────────────────────────────

  type BusinessRule {
    id: ID!
    name: String!
    description: String
    entityType: String!
    eventType: String!
    conditionLogic: String!
    conditions: String
    actions: String
    priority: Int!
    stopOnMatch: Boolean!
    enabled: Boolean!
  }

  input CreateBusinessRuleInput {
    name: String!
    description: String
    entityType: String!
    eventType: String!
    conditionLogic: String
    conditions: String
    actions: String
    priority: Int
    stopOnMatch: Boolean
    enabled: Boolean
  }

  input UpdateBusinessRuleInput {
    name: String
    description: String
    eventType: String
    conditionLogic: String
    conditions: String
    actions: String
    priority: Int
    stopOnMatch: Boolean
    enabled: Boolean
  }

  # ── SLA Policy ─────────────────────────────────────────────────────────────

  type SLAPolicyNode {
    id: ID!
    name: String!
    entityType: String!
    priority: String
    category: String
    teamId: String
    teamName: String
    timezone: String!
    responseMinutes: Int!
    resolveMinutes: Int!
    businessHours: Boolean!
    enabled: Boolean!
  }

  input CreateSLAPolicyInput {
    name: String!
    entityType: String!
    priority: String
    category: String
    teamId: String
    timezone: String
    responseMinutes: Int!
    resolveMinutes: Int!
    businessHours: Boolean
  }

  input UpdateSLAPolicyInput {
    name: String
    priority: String
    category: String
    teamId: String
    timezone: String
    responseMinutes: Int
    resolveMinutes: Int
    businessHours: Boolean
    enabled: Boolean
  }

  extend type Query {
    autoTriggers(entityType: String): [AutoTrigger!]!
    businessRules(entityType: String): [BusinessRule!]!
    slaPolicies(entityType: String): [SLAPolicyNode!]!
  }

  extend type Mutation {
    createAutoTrigger(input: CreateAutoTriggerInput!): AutoTrigger!
    updateAutoTrigger(id: ID!, input: UpdateAutoTriggerInput!): AutoTrigger!
    deleteAutoTrigger(id: ID!): Boolean!

    createBusinessRule(input: CreateBusinessRuleInput!): BusinessRule!
    updateBusinessRule(id: ID!, input: UpdateBusinessRuleInput!): BusinessRule!
    deleteBusinessRule(id: ID!): Boolean!
    reorderBusinessRules(ruleIds: [String!]!): [BusinessRule!]!

    createSLAPolicy(input: CreateSLAPolicyInput!): SLAPolicyNode!
    updateSLAPolicy(id: ID!, input: UpdateSLAPolicyInput!): SLAPolicyNode!
    deleteSLAPolicy(id: ID!): Boolean!
  }
`
