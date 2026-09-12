/**
 * Label Neo4j → tipo del metamodello.
 *
 * I tipi base sono una mappa statica; i tipi definiti dal cliente vengono
 * registrati da chi carica il metamodello (`schemaCache.regenerateSchema`).
 *
 * ## Com'era (A-17)
 * La mappa dinamica era **una sola, globale**: `registerCITypes` scriveva in
 * `Record<label, nome>` senza tenant. Due clienti che creano un tipo con lo
 * stesso nome condividono la label per costruzione (`toPascalCase(name)`), e
 * chi registrava per ultimo decideva il nome del tipo **per tutti**: se c-one
 * chiamava `load_balancer` un tipo e c-two `loadBalancer` un altro, i CI di
 * uno venivano mostrati con il tipo dell'altro. Silenzioso.
 *
 * ## Com'è
 * Una mappa **per tenant**, e chi legge passa il tenant — il compilatore non
 * lascia scappare un chiamante, perché `tenantId` è il primo parametro
 * obbligatorio. `clearCITypes(tenantId)` è registrata come cache del
 * metamodello (`schemaInvalidator`): il canale Redis la svuota in ogni
 * processo quando i tipi cambiano.
 */
import { logger } from './logger.js'
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'

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

/**
 * Mappe dei tipi definiti dal cliente, UNA PER TENANT, popolate al caricamento
 * del metamodello: `tenantId → { ErpSystem: 'erp_system', … }`.
 */
const dynamicLabelToType = new Map<string, Record<string, string>>()

// Technical labels that are not CI types
const IGNORE_LABELS = new Set(['ConfigurationItem', 'CIBase', '_BaseNode'])

/**
 * Called by schemaCache after loading the metamodel, per tenant.
 * Registers that tenant's CI types so ciTypeFromLabels can resolve them.
 * Sostituisce la mappa del tenant: un tipo cancellato sparisce davvero.
 */
export function registerCITypes(tenantId: string, types: { neo4jLabel: string; name: string }[]): void {
  const map: Record<string, string> = {}
  for (const t of types) {
    if (!STATIC_LABEL_TO_TYPE[t.neo4jLabel]) map[t.neo4jLabel] = t.name
  }
  dynamicLabelToType.set(tenantId, map)
}

/**
 * Label ignote già segnalate, PER TENANT: evita di inondare i log a ogni
 * query di lista. Per tenant anche questo, altrimenti il primo cliente che
 * incontra una label zittisce il log di tutti gli altri.
 */
const reportedUnknownLabels = new Map<string, Set<string>>()

/**
 * Dimentica i tipi di un tenant: li ricaricherà chi rigenera il metamodello.
 * La chiama il canale del metamodello (A-16), qui e negli altri processi.
 */
export function clearCITypes(tenantId: string): void {
  dynamicLabelToType.delete(tenantId)
  reportedUnknownLabels.delete(tenantId)
}

/** Vero se i tipi di questo tenant sono stati caricati in QUESTO processo. */
export function hasCITypes(tenantId: string): boolean {
  return dynamicLabelToType.has(tenantId)
}

registerMetamodelCacheClearer('ci-type-labels', clearCITypes)

/**
 * Derives the canonical CI type string from a Neo4j labels array, **for a
 * tenant**. Checks static base types first, then that tenant's registered
 * dynamic types. The `type` property on CI nodes is null — labels are the only
 * source of truth.
 *
 * A label missing from both maps means a metamodel inconsistency (stale CI of
 * a deleted type, or a type not yet registered): it is reported as an ERROR
 * (once per tenant and label) and the type is derived by convention
 * (PascalCase → snake_case) so a single orphan CI does not 500 every list
 * query. A node with no usable label at all throws — that CI is structurally
 * broken.
 *
 * Il log distingue i due casi, perché la causa e il rimedio sono diversi:
 * «label ignota» (CI orfano di un tipo cancellato) e «i tipi di questo tenant
 * non sono mai stati caricati in questo processo» — il secondo capita nei
 * processi che non costruiscono lo schema GraphQL (`worker`, `events-worker`):
 * lì la mappa dinamica è vuota e OGNI tipo del cliente finisce per convenzione.
 */
export function ciTypeFromLabels(tenantId: string, labels: string[]): string {
  const dynamic = dynamicLabelToType.get(tenantId)
  for (const label of labels) {
    if (STATIC_LABEL_TO_TYPE[label]) return STATIC_LABEL_TO_TYPE[label]
    const fromTenant = dynamic?.[label]
    if (fromTenant) return fromTenant
  }
  const relevant = labels.filter(l => !IGNORE_LABELS.has(l))
  const first = relevant[0]
  if (!first) {
    throw new Error(`ciTypeFromLabels: CI has no usable label (tenant ${tenantId}, labels: ${JSON.stringify(labels)})`)
  }
  let reported = reportedUnknownLabels.get(tenantId)
  if (!reported) {
    reported = new Set<string>()
    reportedUnknownLabels.set(tenantId, reported)
  }
  if (!reported.has(first)) {
    reported.add(first)
    const loaded = dynamic !== undefined
    logger.error({ tenantId, label: first, labels, tenantTypesLoaded: loaded },
      loaded
        ? '[ciTypeFromLabels] label not registered in the metamodel of this tenant — stale CI of a deleted type? Type derived by convention'
        : '[ciTypeFromLabels] i tipi CI di questo tenant non sono stati caricati in questo processo (nessuna rigenerazione dello schema qui): tipo derivato per convenzione')
  }
  // PascalCase → snake_case (the actual naming convention, unlike the previous
  // plain lowercase which produced strings matching no metamodel type)
  return first.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}
