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
    """La persona riceve le e-mail di notifica (dal Profilo). null = nessun utente nel grafo per questa identità."""
    emailNotifications: Boolean
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
    # Aggiunge (member: true) o toglie un membro dal team, senza toccare gli altri team dell'utente.
    setTeamMember(teamId: ID!, userId: ID!, member: Boolean!): Team!
    # Designa (o rimuove) il team come "Change Manager". Uno solo per tenant.
    setChangeManagerTeam(teamId: ID!, value: Boolean!): Team!
  }
  `
}
