// Whitelist of node labels and relationship types the custom report builder
// may interpolate into Cypher. Derived from the metamodel (getNavigableEntities)
// plus the fixed ITSM graph; anything outside it is rejected at build time AND
// at persistence time, so a malicious saved section is never executed by the
// scheduler either.

import { getNavigableEntities } from './navigableGraph.js'
import { LABEL_RE, REL_TYPE_RE } from './cypherIdentifiers.js'
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'

export interface ReportWhitelist {
  labels:            ReadonlySet<string>
  relationshipTypes: ReadonlySet<string>
}

/**
 * Fixed labels that are always reportable (ITSM core + CI base labels).
 * CI type labels from the metamodel are added dynamically per tenant.
 */
export const STATIC_REPORT_LABELS: readonly string[] = [
  'ConfigurationItem', 'CIBase',
  'Application', 'Server', 'Database', 'DatabaseInstance', 'Certificate',
  'NetworkDevice', 'VirtualMachine', 'BusinessApplication',
  'Incident', 'Change', 'ChangeTask', 'Problem', 'KnownError', 'ServiceRequest',
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

  const entities = await getNavigableEntities(tenantId)
  for (const e of entities) {
    if (LABEL_RE.test(e.neo4jLabel)) labels.add(e.neo4jLabel)
    for (const r of e.relations) {
      if (REL_TYPE_RE.test(r.relationshipType)) relationshipTypes.add(r.relationshipType)
      if (r.targetNeo4jLabel && LABEL_RE.test(r.targetNeo4jLabel)) labels.add(r.targetNeo4jLabel)
    }
  }

  const value: ReportWhitelist = { labels, relationshipTypes }
  cache.set(tenantId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}

/** Test hook: drop every cached whitelist. */
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

registerMetamodelCacheClearer('report-whitelist', invalidateReportWhitelist)
