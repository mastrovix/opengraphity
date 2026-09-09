export function topologySDL(): string {
  return `
  # ── Topology ──────────────────────────────────────────────────────────────────

  type TopologyNode {
    id:            ID!
    name:          String!
    type:          String!
    status:        String!
    """Salute dal monitoraggio: operational | degraded | down; null se nessun evento ha mai riguardato il CI."""
    health:        String
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
    # Cap server sui nodi (NODE_LIMIT): il web lo mostra nell'avviso di troncamento.
    nodeLimit: Int!
    truncated: Boolean!
  }
  `
}
