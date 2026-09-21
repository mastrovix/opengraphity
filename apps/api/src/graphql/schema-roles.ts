export function rolesSDL(): string {
  return `
  # ── Ruoli e permessi (ondata 7 di «Nulla cablato») ──────────────────────────

  """Un ruolo dell'organizzazione: un nome e i permessi del catalogo."""
  type Role {
    key:         String!
    """Nome scelto dall'organizzazione; null per un ruolo di fabbrica mai rinominato (l'interfaccia lo traduce dalla chiave)."""
    name:        String
    permissions: [String!]!
    """I ruoli di fabbrica si modificano ma non si cancellano."""
    isFactory:   Boolean!
    """Quante persone hanno questo ruolo."""
    userCount:   Int!
  }

  input RoleInput {
    name:        String
    permissions: [String!]!
  }

  extend type Query {
    roles: [Role!]!
  }

  extend type Mutation {
    createRole(input: RoleInput!): Role!
    updateRole(key: String!, input: RoleInput!): Role!
    deleteRole(key: String!): Boolean!
  }
  `
}
