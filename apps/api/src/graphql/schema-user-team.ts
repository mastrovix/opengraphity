export function userTeamSDL(): string {
  return `
  # ── User & Team ───────────────────────────────────────────────────────────────

  type User {
    id: ID!
    tenantId: String!
    email: String!
    name: String!
    role: String!
    teamId: String
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
    createdAt: String!
    members: [User!]!
    ownedCIs: [CIBase!]!
    supportedCIs: [CIBase!]!
  }
  `
}
