export function userTeamSDL(): string {
  return `
  # ── User & Team ───────────────────────────────────────────────────────────────

  type User {
    id: ID!
    tenantId: String!
    email: String!
    name: String!
    code: String!
    """false = persona disattivata: non entra, non riceve assegnazioni né notifiche; storico e ticket restano."""
    active: Boolean!
    firstName: String
    lastName: String
    role: String!
    """
    I permessi del ruolo della persona (ondata 7 di «Nulla cablato»): le
    interfacce mostrano pagine e azioni da qui, non dal nome del ruolo.
    """
    permissions: [String!]!
    """Il nome del ruolo scelto dall'organizzazione; null per un ruolo di fabbrica mai rinominato."""
    roleName: String
    slackId: String
    """La persona riceve le e-mail di notifica (dal Profilo). null = nessun utente nel grafo per questa identità."""
    emailNotifications: Boolean
    """
    La lingua scelta dalla persona (\`en\`, \`it\`); null = quella dell'organizzazione.
    Web e portale la leggono da qui: prima stava solo nel browser del web.
    """
    language: String
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
    """Il ruolo di una persona (ondata 7). Rifiutato se nessuno potrebbe più gestire persone e ruoli."""
    setUserRole(userId: ID!, role: String!): User!
    """Disattiva (false) o riattiva (true) una persona: account del realm spento e sessioni chiuse. Mai sé stessi né l'ultima persona che gestisce persone e ruoli."""
    setUserActive(userId: ID!, active: Boolean!): User!
    setTeamManager(teamId: ID!, userId: ID!): Team!
    removeTeamManager(teamId: ID!): Team!
    # Aggiunge (member: true) o toglie un membro dal team, senza toccare gli altri team dell'utente.
    setTeamMember(teamId: ID!, userId: ID!, member: Boolean!): Team!
    # Designa (o rimuove) il team come "Change Manager". Uno solo per tenant.
    setChangeManagerTeam(teamId: ID!, value: Boolean!): Team!
  }
  `
}
