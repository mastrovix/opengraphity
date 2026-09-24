/**
 * The CIs a `ref_ci` form field may point to: its declared TYPES and its
 * CMDB FILTER (the same `{rules:[…]}` document as the CMDB lists).
 *
 * Review of 23 Sep 2026: only the web client applied the filter. The portal's
 * choices offered every CI of the types, and submit checked only that the CI
 * existed in the tenant — a field restricted to production servers offered
 * and accepted test servers. One builder now serves the save-time check, the
 * portal's choices and the submit check, so the three cannot disagree.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import { buildAdvancedWhere } from './filterBuilder.js'
import { toPascalCase } from '@opengraphity/schema-generator'

/** The fields every CI has, filterable on any type (as the CMDB «all CIs» list). */
export const ALL_CIS_ALLOWED_FIELDS: ReadonlySet<string> = new Set(['name', 'status', 'environment', 'createdAt', 'health'])

/** The fields a filter on these types may name: the common ones plus the types' own. */
export async function refFilterAllowedFields(session: Session, tenantId: string, refTypes: readonly string[]): Promise<Set<string>> {
  // `tenant-ok(condivisi)`: i tipi `base` sono condivisi, quelli del cliente filtrati.
  const campi = await runQuery<{ name: string }>(session, `
    MATCH (t:CITypeDefinition)-[:HAS_FIELD]->(f:CIFieldDefinition)
    WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))
      AND ($tipi = [] OR t.name IN $tipi)
      AND coalesce(f.is_system, false) = false
    RETURN DISTINCT f.name AS name
  `, { tenantId, tipi: [...refTypes] })
  return new Set([...ALL_CIS_ALLOWED_FIELDS, ...campi.map((c) => c.name)])
}

/**
 * The WHERE on `n` (a :ConfigurationItem) for the field's types and filter.
 * Its parameters go into `params` (`$refLabels`, `af_*`). A filter that no
 * longer builds throws: an empty condition would offer everything.
 */
export async function refCiConditions(
  session: Session, tenantId: string, refTypes: readonly string[], refFilter: string | null, params: Record<string, unknown>,
): Promise<string> {
  const conditions: string[] = []
  if (refTypes.length > 0) {
    // Type names become labels; the list travels as a PARAMETER, not interpolated.
    params['refLabels'] = refTypes.map((t) => toPascalCase(t))
    conditions.push('any(l IN labels(n) WHERE l IN $refLabels)')
  }
  if (refFilter && refFilter.trim() !== '') {
    const where = buildAdvancedWhere(refFilter, params, await refFilterAllowedFields(session, tenantId, refTypes), 'n')
    if (where) conditions.push(`(${where})`)
  }
  return conditions.join(' AND ')
}
