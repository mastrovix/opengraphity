/**
 * Single source of truth for the static CI type ↔ Neo4j label mapping.
 * Every hardcoded label list in resolvers must derive from here — adding a
 * new CI type means touching THIS file (plus the global_search fulltext
 * index in infra/neo4j/init/constraints.cypher, which cannot be dynamic).
 * Dynamic tenant-defined types are handled separately via ciTypeFromLabels.
 */

// Whitelist: type string → Neo4j label (prevents Cypher injection)
export const TYPE_TO_LABEL: Record<string, string> = {
  business_capability:  'BusinessCapability',
  business_application: 'BusinessApplication',
  application:          'Application',
  database:             'Database',
  database_instance:    'DatabaseInstance',
  db_instance:          'DatabaseInstance',
  server:               'Server',
  certificate:          'Certificate',
  ssl_certificate:      'SslCertificate',
  virtual_machine:      'VirtualMachine',
  network_device:       'NetworkDevice',
  storage:              'Storage',
  cloud_service:        'CloudService',
  api_endpoint:         'ApiEndpoint',
  microservice:         'Microservice',
}

export const ALL_CI_LABELS: string[] = [...new Set(Object.values(TYPE_TO_LABEL))]

/** `(alias:Label1 OR alias:Label2 …)` — for WHERE clauses on an alias. */
export function ciLabelPredicate(alias: string): string {
  return '(' + ALL_CI_LABELS.map((l) => `${alias}:${l}`).join(' OR ') + ')'
}

/**
 * Relationship types that express "depends on / runs on / is realized by":
 * the edge always points dependent → dependency, so impact traversals
 * (who breaks if X breaks?) follow them incoming from the root.
 */
export const IMPACT_REL_TYPES = 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|REALIZES|ENABLED_BY'
