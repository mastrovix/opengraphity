export function userTeamSDL(): string {
  return `
  # ── User & Team ───────────────────────────────────────────────────────────────

  type User {
    id: ID!
    tenantId: String!
    email: String!
    name: String!
    code: String!
    firstName: String
    lastName: String
    role: String!
    slackId: String
    createdAt: String
    teams: [Team!]!
  }

  type Team {
    id: ID!
    tenantId: String!
    name: String!
    description: String
    type: String
    # 'internal' | 'external'. null = team creato prima che il campo esistesse: la diagnostica lo segnala.
    sourcing: String
    createdAt: String!
    manager: User
    members: [User!]!
    ownedCIs: [CIBase!]!
    supportedCIs: [CIBase!]!
    # True se questo è il team "Change Manager" (approva le change normal/emergency).
    isChangeManager: Boolean
  }

  input CreateUserInput {
    email: String!
    name: String!
    password: String!
    role: String!
    teamIds: [ID!]
  }

  extend type Mutation {
    createUser(input: CreateUserInput!): User!
    updateUserTeams(userId: ID!, teamIds: [ID!]!): User!
    setTeamManager(teamId: ID!, userId: ID!): Team!
    removeTeamManager(teamId: ID!): Team!
    # Designa (o rimuove) il team come "Change Manager". Uno solo per tenant.
    setChangeManagerTeam(teamId: ID!, value: Boolean!): Team!
  }
  `
}
