export const collaborationSchema = `
  # ── User Search (for @mention autocomplete) ─────────────────────────────────

  type UserSuggestion {
    id: ID!
    name: String!
    email: String!
    """The key of the person's role (the picker shows its name)."""
    role: String
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

  "A person named by id: \`active\` says whether they can still act."
  type NamedUser {
    id:     ID!
    name:   String!
    email:  String!
    active: Boolean!
  }

  extend type Query {
    """
    Active people whose name or e-mail contains the text. With \`permission\`,
    only the people whose role grants it (tour of 23 Sep 2026): the pickers
    that offer «who can do this job» ask the server as the user types instead
    of downloading every person of the organization.
    """
    searchUsers(search: String!, limit: Int, permission: String): [UserSuggestion!]!
    """
    The people with these ids, inactive ones too (at most 100): the name of
    whom a rule or a step already names, without downloading the directory.
    """
    usersByIds(ids: [ID!]!): [NamedUser!]!
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
