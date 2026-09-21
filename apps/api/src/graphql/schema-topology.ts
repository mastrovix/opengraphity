export function topologySDL(): string {
  return `
  # ── Topology ──────────────────────────────────────────────────────────────────

  type TopologyNode {
    id:            ID!
    name:          String!
    type:          String!
    """Lo stato del ciclo di vita del CI, dal Dizionario del cliente; null se il CI non ne ha uno."""
    status:        String
    """Vero se lo stato è fra quelli che la policy degli allarmi del cliente considera «in manutenzione»."""
    inMaintenance: Boolean!
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
