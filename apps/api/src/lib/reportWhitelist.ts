// Whitelist of node labels and relationship types the custom report builder
// may interpolate into Cypher. Derived from the metamodel (getNavigableEntities)
// plus the fixed ITSM graph; anything outside it is rejected at build time AND
// at persistence time, so a malicious saved section is never executed by the
// scheduler either.

import { getNavigableEntities } from './navigableGraph.js'
import { LABEL_RE, REL_TYPE_RE } from './cypherIdentifiers.js'
import { isTemporalField } from '@opengraphity/types'
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'

export interface ReportWhitelist {
  labels:            ReadonlySet<string>
  relationshipTypes: ReadonlySet<string>
  /**
   * Per etichetta, i campi su cui si può chiedere un PERIODO — quelli che il
   * metamodello dichiara data e quelli che il prodotto spedisce tali
   * (`isTemporalField`). Serve a rifiutare al salvataggio un «raggruppa per
   * mese» su «Stato», che a esecuzione dava «Text cannot be parsed to a
   * DateTime "completed"».
   */
  temporalFields:    ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Fixed labels that are always reportable (ITSM core + SHIPPED CI type labels).
 * CI type labels from the metamodel are added dynamically per tenant. No label
 * without a shipped type (`NetworkDevice`/`VirtualMachine` were: revisione del
 * 14 set 2026 · F19, pinned by lib/__tests__/staticCiLabels.test.ts).
 */
export const STATIC_REPORT_LABELS: readonly string[] = [
  'ConfigurationItem', 'CIBase',
  'Application', 'Server', 'Database', 'DatabaseInstance', 'Certificate',
  'BusinessApplication',
  // `ChangeTask` NON c'è più (20 set 2026): nessun nodo la porta, nessuna
  // query la nomina. Restava riportabile — cioè un report la poteva nominare
  // e non avrebbe trovato mai niente.
  'Incident', 'Change', 'Problem', 'KnownError', 'ServiceRequest',
  // I TASK (20 set 2026): quello generico che un passo di workflow crea su
  // qualunque ticket, e i cinque per CI delle change. Erano invisibili ai
  // report — «quanti aperti per squadra» non si poteva chiedere — e i cinque
  // lo erano da sempre, non da adesso.
  'Task', 'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask',
  'Team', 'User',
  'WorkflowDefinition', 'WorkflowInstance',
  'ReportTemplate',
]

/** Fixed relationship types of the ITSM graph a report may traverse. */
export const STATIC_REPORT_RELATIONSHIP_TYPES: readonly string[] = [
  'AFFECTS', 'AFFECTED_BY', 'AFFECTS_CI',
  'ASSIGNED_TO', 'ASSIGNED_TO_TEAM', 'REQUESTED_BY', 'RESOLVED_BY', 'APPROVED_BY',
  'COMPLETED_BY', 'CREATED_BY', 'WATCHES',
  'MEMBER_OF', 'HAS_MEMBER', 'OWNED_BY', 'SUPPORTED_BY', 'MANAGED_BY',
  'BELONGS_TO', 'PARENT_OF', 'RELATED_TO', 'CAUSED_BY', 'REALIZES',
  'DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE',
  'HAS_TASK',
  'HAS_CHANGE_TASK', 'HAS_ASSESSMENT', 'HAS_DEPLOY_PLAN', 'HAS_DEPLOYMENT',
  'HAS_VALIDATION', 'HAS_APPROVAL', 'HAS_REVIEW', 'HAS_COMMENT', 'HAS_SLA',
  'HAS_WORKFLOW', 'CURRENT_STEP', 'STEP_HISTORY', 'HAS_STEP', 'TRANSITIONS_TO',
]

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { value: ReportWhitelist; expiresAt: number }>()

/**
 * Builds the per-tenant whitelist: static sets ∪ metamodel entities (labels,
 * relation types and relation target labels). Cached 60s per tenant.
 */
export async function getReportWhitelist(tenantId: string): Promise<ReportWhitelist> {
  const hit = cache.get(tenantId)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const labels = new Set<string>(STATIC_REPORT_LABELS)
  const relationshipTypes = new Set<string>(STATIC_REPORT_RELATIONSHIP_TYPES)

  const temporalFields = new Map<string, ReadonlySet<string>>()

  const entities = await getNavigableEntities(tenantId)
  for (const e of entities) {
    if (LABEL_RE.test(e.neo4jLabel)) labels.add(e.neo4jLabel)
    for (const r of e.relations) {
      if (REL_TYPE_RE.test(r.relationshipType)) relationshipTypes.add(r.relationshipType)
      if (r.targetNeo4jLabel && LABEL_RE.test(r.targetNeo4jLabel)) labels.add(r.targetNeo4jLabel)
    }
    const date = new Set(e.fields.filter((f) => isTemporalField(f.name, f.fieldType)).map((f) => f.name))
    if (date.size > 0) temporalFields.set(e.neo4jLabel, date)
  }

  const value: ReportWhitelist = { labels, relationshipTypes, temporalFields }
  cache.set(tenantId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}

/**
 * Ogni whitelist in cache, di ogni tenant. La chiamano i test e il canale del
 * metamodello alla ripresa dopo una sottoscrizione persa (PRB00000003).
 */
export function clearReportWhitelistCache(): void {
  cache.clear()
}

/**
 * Un tenant solo: la chiama il canale del metamodello (A-16) quando un tipo,
 * un campo o una relazione cambiano — qui o in un altro processo. Prima questa
 * cache restava vecchia per 60 s anche nel processo che aveva servito la
 * mutation: un tipo nuovo non era riportabile e uno cancellato lo era ancora.
 */
export function invalidateReportWhitelist(tenantId: string): void {
  cache.delete(tenantId)
}

registerMetamodelCacheClearer('report-whitelist', invalidateReportWhitelist, clearReportWhitelistCache)
