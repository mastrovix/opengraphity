export function topologySDL(): string {
  return `
  # ── Topology ──────────────────────────────────────────────────────────────────

  type TopologyNode {
    id:            ID!
    name:          String!
    type:          String!
    status:        String!
    environment:   String
    ownerGroup:    String
    incidentCount: Int!
    changeCount:   Int!
  }

  type TopologyEdge {
    source: ID!
    target: ID!
    type:   String!
  }

  type TopologyData {
    nodes:     [TopologyNode!]!
    edges:     [TopologyEdge!]!
    truncated: Boolean!
  }
  `
}
