export const integrationsSchema = `
  # ── Inbound Webhooks ────────────────────────────────────────────────────────

  type InboundWebhook {
    id: ID!
    name: String!
    entityType: String!
    """Solo per entityType = event: generic | alertmanager | grafana | zabbix | datadog | dynatrace. Null per gli altri tipi."""
    connectorKind: String
    """JSON. Per il connettore generic: { campoNormalizzato: "percorso.puntato.nel.payload" } (title, severity, status, resource, resourceKind, externalId, description, labels, startsAt, endsAt)."""
    fieldMapping: String!
    """JSON. Valori usati quando il campo non è nel payload; per generic contiene sempre resourceKind (hostname | ip | fqdn | external_id | name)."""
    defaultValues: String
    """JSON, solo generic: { severity: { valoreSorgente: info|warning|critical }, status: { valoreSorgente: firing|resolved } }, confronto senza maiuscole."""
    valueMapping: String
    transformScript: String
    enabled: Boolean!
    lastReceivedAt: String
    receiveCount: Int!
    """Motivo dell'ultimo payload rifiutato (400); null dopo il primo batch accettato."""
    lastError: String
    lastErrorAt: String
    errorCount: Int!
    createdAt: String!
  }

  type InboundWebhookWithToken {
    id: ID!
    name: String!
    token: String!
    entityType: String!
    connectorKind: String
    fieldMapping: String!
    defaultValues: String
    valueMapping: String
    enabled: Boolean!
    createdAt: String!
  }

  input CreateInboundWebhookInput {
    name: String!
    entityType: String!
    """Obbligatorio se entityType = event (generic | alertmanager | grafana | zabbix | datadog | dynatrace); vietato altrimenti."""
    connectorKind: String
    fieldMapping: String!
    defaultValues: String
    valueMapping: String
    transformScript: String
  }

  input UpdateInboundWebhookInput {
    name: String
    entityType: String
    connectorKind: String
    fieldMapping: String
    defaultValues: String
    valueMapping: String
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
    inboundWebhooks(filters: String, sortField: String, sortDirection: String): [InboundWebhook!]!
    outboundWebhooks(filters: String, sortField: String, sortDirection: String): [OutboundWebhook!]!
    apiKeys(filters: String, sortField: String, sortDirection: String): [ApiKeyInfo!]!
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
