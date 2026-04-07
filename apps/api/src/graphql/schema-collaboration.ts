export const collaborationSchema = `
  # ── User Search (for @mention autocomplete) ─────────────────────────────────

  type UserSuggestion {
    id: ID!
    name: String!
    email: String!
  }

  # ── Watchers ────────────────────────────────────────────────────────────────

  type Watcher {
    id: ID!
    name: String!
    email: String!
    watchedAt: String!
  }

  # ── Internal Messages (agent-only chat per entity) ──────────────────────────

  type InternalMessage {
    id: ID!
    authorId: String!
    authorName: String!
    body: String!
    mentions: [String!]!
    createdAt: String!
    editedAt: String
  }

  extend type Query {
    searchUsers(search: String!, limit: Int): [UserSuggestion!]!
    watchers(entityType: String!, entityId: ID!): [Watcher!]!
    isWatching(entityType: String!, entityId: ID!): Boolean!
    internalMessages(entityType: String!, entityId: ID!, limit: Int, before: String): [InternalMessage!]!
  }

  extend type Mutation {
    watchEntity(entityType: String!, entityId: ID!): Boolean!
    unwatchEntity(entityType: String!, entityId: ID!): Boolean!
    addWatcher(entityType: String!, entityId: ID!, userId: ID!): Boolean!
    removeWatcher(entityType: String!, entityId: ID!, userId: ID!): Boolean!
    sendInternalMessage(entityType: String!, entityId: ID!, body: String!): InternalMessage!
    editInternalMessage(messageId: ID!, body: String!): InternalMessage!
    deleteInternalMessage(messageId: ID!): Boolean!
  }
`
