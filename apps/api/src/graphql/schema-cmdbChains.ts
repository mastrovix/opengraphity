/** CMDB chains (24 Sep 2026): which relations between CIs are admitted — services/cmdbChains. */
export function cmdbChainsSDL(): string {
  return `
  # ── CMDB chains ───────────────────────────────────────────────────────────────

  """A type in a chain: the root, or a type linked to the one above it."""
  type CmdbChainNode {
    id:           ID!
    """The type above; null for the root."""
    parentId:     ID
    """The CI type name (e.g. server)."""
    ciType:       String!
    """The relation of the link to the type above; null for the root."""
    relationType: String
    """outgoing: the type above → this one; incoming: this one → the type above. Null for the root."""
    direction:    String
    """A CI of the type above must have at least one CI in service along this link."""
    required:     Boolean!
  }

  type CmdbChain {
    id:        ID!
    name:      String!
    """application, infrastructure or mixed: which chain families its types may have."""
    kind:      String!
    nodes:     [CmdbChainNode!]!
    createdAt: String
    updatedAt: String
  }

  """A link the metamodel and the families allow below a type, in a chain of a given kind."""
  type CmdbChainLinkOption {
    relationType: String!
    direction:    String!
    ciType:       String!
  }

  input CmdbChainNodeInput {
    id:           ID!
    parentId:     ID
    ciType:       String!
    relationType: String
    direction:    String
    required:     Boolean
  }

  input CmdbChainInput {
    name:  String!
    kind:  String!
    nodes: [CmdbChainNodeInput!]!
  }

  extend type Query {
    cmdbChains: [CmdbChain!]!
    cmdbChainLinkOptions(ciType: String!, kind: String!): [CmdbChainLinkOption!]!
  }

  extend type Mutation {
    createCmdbChain(input: CmdbChainInput!): CmdbChain!
    updateCmdbChain(id: ID!, input: CmdbChainInput!): CmdbChain!
    deleteCmdbChain(id: ID!): Boolean!
  }
  `
}
