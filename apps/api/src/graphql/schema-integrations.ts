export const integrationsSchema = `
  # ── Inbound Webhooks ────────────────────────────────────────────────────────

  type InboundWebhook {
    id: ID!
    name: String!
    entityType: String!
    fieldMapping: String!
    defaultValues: String
    transformScript: String
    enabled: Boolean!
    lastReceivedAt: String
    receiveCount: Int!
    createdAt: String!
  }

  type InboundWebhookWithToken {
    id: ID!
    name: String!
    token: String!
    entityType: String!
    fieldMapping: String!
    defaultValues: String
    enabled: Boolean!
    createdAt: String!
  }

  input CreateInboundWebhookInput {
    name: String!
    entityType: String!
    fieldMapping: String!
    defaultValues: String
    transformScript: String
  }

  input UpdateInboundWebhookInput {
    name: String
    entityType: String
    fieldMapping: String
    defaultValues: String
    transformScript: String
    enabled: Boolean
  }

  # ── Outbound Webhooks ───────────────────────────────────────────────────────

  type OutboundWebhook {
    id: ID!
    name: String!
    url: String!
    method: String!
    headers: String
    events: [String!]!
    payloadTemplate: String
    enabled: Boolean!
    lastSentAt: String
    lastStatusCode: Int
    sendCount: Int!
    errorCount: Int!
    lastError: String
    retryOnFailure: Boolean!
  }

  type WebhookTestResult {
    success: Boolean!
    statusCode: Int
    responseBody: String
    error: String
    duration: Int
  }

  input CreateOutboundWebhookInput {
    name: String!
    url: String!
    method: String
    headers: String
    events: [String!]!
    payloadTemplate: String
    secret: String
    enabled: Boolean
    retryOnFailure: Boolean
  }

  input UpdateOutboundWebhookInput {
    name: String
    url: String
    method: String
    headers: String
    events: [String!]
    payloadTemplate: String
    secret: String
    enabled: Boolean
    retryOnFailure: Boolean
  }

  # ── API Keys ────────────────────────────────────────────────────────────────

  type ApiKeyInfo {
    id: ID!
    name: String!
    keyPrefix: String!
    permissions: [String!]!
    rateLimit: Int!
    enabled: Boolean!
    lastUsedAt: String
    requestCount: Int!
    createdBy: String
    expiresAt: String
    createdAt: String!
  }

  type ApiKeyWithSecret {
    id: ID!
    name: String!
    key: String!
    keyPrefix: String!
    permissions: [String!]!
  }

  input CreateApiKeyInput {
    name: String!
    permissions: [String!]!
    rateLimit: Int
    expiresAt: String
  }

  input UpdateApiKeyInput {
    name: String
    permissions: [String!]
    rateLimit: Int
    enabled: Boolean
    expiresAt: String
  }

  # ── Queries & Mutations ─────────────────────────────────────────────────────

  extend type Query {
    inboundWebhooks: [InboundWebhook!]!
    outboundWebhooks: [OutboundWebhook!]!
    apiKeys: [ApiKeyInfo!]!
  }

  extend type Mutation {
    createInboundWebhook(input: CreateInboundWebhookInput!): InboundWebhookWithToken!
    updateInboundWebhook(id: ID!, input: UpdateInboundWebhookInput!): InboundWebhook!
    deleteInboundWebhook(id: ID!): Boolean!
    regenerateWebhookToken(id: ID!): InboundWebhookWithToken!

    createOutboundWebhook(input: CreateOutboundWebhookInput!): OutboundWebhook!
    updateOutboundWebhook(id: ID!, input: UpdateOutboundWebhookInput!): OutboundWebhook!
    deleteOutboundWebhook(id: ID!): Boolean!
    testOutboundWebhook(id: ID!): WebhookTestResult!

    createApiKey(input: CreateApiKeyInput!): ApiKeyWithSecret!
    updateApiKey(id: ID!, input: UpdateApiKeyInput!): ApiKeyInfo!
    deleteApiKey(id: ID!): Boolean!
    regenerateApiKey(id: ID!): ApiKeyWithSecret!
  }
`
