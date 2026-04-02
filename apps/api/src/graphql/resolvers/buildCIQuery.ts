import { buildAdvancedWhere } from '../../lib/filterBuilder.js'

export { buildAdvancedWhere }

// ── Allowed base fields ───────────────────────────────────────────────────────

// Allowed base field keys (camelCase) — validated before use in Cypher
export const ALLOWED_BASE_FIELDS = new Set([
  'name', 'status', 'environment', 'description', 'notes',
  'createdAt', 'updatedAt', 'ownerGroup',
])

export const ALL_CIS_ALLOWED_FIELDS = new Set(['name', 'status', 'environment', 'createdAt'])

// ── Sort whitelist ────────────────────────────────────────────────────────────

export const CI_SORT_WHITELIST: Record<string, string> = {
  name: 'n.name', status: 'n.status', environment: 'n.environment', createdAt: 'n.created_at',
}

// ── ciOrderBy ─────────────────────────────────────────────────────────────────

export function ciOrderBy(sortField?: string, sortDirection?: string): string {
  const sortCol = sortField && CI_SORT_WHITELIST[sortField]
  const sortDir = sortDirection?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
  return sortCol ? `${sortCol} ${sortDir}` : 'n.name ASC'
}

// ── buildBaseWhere ────────────────────────────────────────────────────────────

export function buildBaseWhere(
  filters: string | undefined,
  params: Record<string, unknown>,
  allowedFields: Set<string>,
): string {
  const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'n', {
    ownerGroup: { relType: 'OWNED_BY', targetLabel: 'Team', searchProp: 'name' },
  }) : ''
  const baseWhere = `($status IS NULL OR n.status = $status)
    AND ($environment IS NULL OR n.environment = $environment)
    AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))`
  return advWhere ? `${baseWhere} AND (${advWhere})` : baseWhere
}
