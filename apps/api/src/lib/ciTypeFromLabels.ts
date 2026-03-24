// Static map: built-in Neo4j CI label → normalized type string
const STATIC_LABEL_TO_TYPE: Record<string, string> = {
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

/**
 * Derives the canonical CI type string from a Neo4j labels array.
 * Checks static base types first, then tenant-registered dynamic types.
 * The `type` property on CI nodes is null — labels are the only source of truth.
 */
export function ciTypeFromLabels(labels: string[]): string {
  for (const label of labels) {
    if (STATIC_LABEL_TO_TYPE[label]) return STATIC_LABEL_TO_TYPE[label]
    if (dynamicLabelToType[label])   return dynamicLabelToType[label]
  }
  // Fallback: first non-ignored label, lowercased
  const relevant = labels.filter(l => !IGNORE_LABELS.has(l))
  return relevant[0]?.toLowerCase() ?? 'unknown'
}
