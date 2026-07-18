// Static map: built-in Neo4j CI label → normalized type string
const STATIC_LABEL_TO_TYPE: Record<string, string> = {
  BusinessCapability:  'business_capability',
  BusinessApplication: 'business_application',
  Application:      'application',
  Server:           'server',
  Database:         'database',
  DatabaseInstance: 'database_instance',
  Certificate:      'certificate',
  SslCertificate:   'ssl_certificate',
  VirtualMachine:   'virtual_machine',
  NetworkDevice:    'network_device',
  Storage:          'storage',
  CloudService:     'cloud_service',
  ApiEndpoint:      'api_endpoint',
  Microservice:     'microservice',
  DynamicCIGroup:   'dynamic_ci_group',
}

// Dynamic map populated from CITypeDefinition nodes at schema load time
// e.g. { ErpSystem: 'erp_system', CustomType: 'custom_type' }
const dynamicLabelToType: Record<string, string> = {}

// Technical labels that are not CI types
const IGNORE_LABELS = new Set(['ConfigurationItem', 'CIBase', '_BaseNode'])

/**
 * Called by schemaCache after loading the metamodel.
 * Registers tenant-defined CI types so ciTypeFromLabels can resolve them.
 */
export function registerCITypes(types: { neo4jLabel: string; name: string }[]) {
  for (const t of types) {
    if (!STATIC_LABEL_TO_TYPE[t.neo4jLabel]) {
      dynamicLabelToType[t.neo4jLabel] = t.name
    }
  }
}

// Unknown labels already reported — avoid flooding the logs on list queries.
const reportedUnknownLabels = new Set<string>()

/**
 * Derives the canonical CI type string from a Neo4j labels array.
 * Checks static base types first, then tenant-registered dynamic types.
 * The `type` property on CI nodes is null — labels are the only source of truth.
 *
 * A label missing from both maps means a metamodel inconsistency (stale CI of
 * a deleted type, or a type not yet registered): it is reported as an ERROR
 * (once per label) and the type is derived by convention (PascalCase →
 * snake_case) so a single orphan CI does not 500 every list query. A node
 * with no usable label at all throws — that CI is structurally broken.
 */
export function ciTypeFromLabels(labels: string[]): string {
  for (const label of labels) {
    if (STATIC_LABEL_TO_TYPE[label]) return STATIC_LABEL_TO_TYPE[label]
    if (dynamicLabelToType[label])   return dynamicLabelToType[label]
  }
  const relevant = labels.filter(l => !IGNORE_LABELS.has(l))
  const first = relevant[0]
  if (!first) {
    throw new Error(`ciTypeFromLabels: CI has no usable label (labels: ${JSON.stringify(labels)})`)
  }
  if (!reportedUnknownLabels.has(first)) {
    reportedUnknownLabels.add(first)
    // Lazy import to avoid a cycle at module load
    void import('./logger.js').then(({ logger }) =>
      logger.error({ label: first, labels },
        '[ciTypeFromLabels] label not registered in the metamodel — stale CI of a deleted type? Type derived by convention'),
    )
  }
  // PascalCase → snake_case (the actual naming convention, unlike the previous
  // plain lowercase which produced strings matching no metamodel type)
  return first.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}
