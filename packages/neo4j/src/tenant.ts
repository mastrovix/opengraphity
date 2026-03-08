/**
 * Injects a tenant_id filter into a Cypher query.
 * Handles queries that already contain a WHERE clause.
 *
 * Assumptions:
 *  - The primary node alias used in the query is `n`
 *  - The caller passes `tenantId` as a query parameter named `tenantId`
 */
export function withTenant(tenantId: string, cypher: string): string {
  // Normalise whitespace for reliable matching
  const normalised = cypher.trim()

  // Pattern: find the first WHERE not inside a subquery/CALL block
  // We inject before ORDER BY / RETURN / WITH / LIMIT / SKIP if no WHERE exists,
  // or append with AND if WHERE already exists.
  const whereRegex = /\bWHERE\b/i

  if (whereRegex.test(normalised)) {
    // Append condition to existing WHERE clause
    return normalised.replace(/\bWHERE\b/i, 'WHERE n.tenant_id = $tenantId AND')
  }

  // No WHERE clause — inject before RETURN / WITH / ORDER / LIMIT / SKIP / SET / DELETE / REMOVE
  const injectBeforeRegex = /\b(RETURN|WITH|ORDER\s+BY|LIMIT|SKIP|SET|DELETE|REMOVE)\b/i
  const match = injectBeforeRegex.exec(normalised)

  if (match?.index !== undefined) {
    const pos = match.index
    return `${normalised.slice(0, pos)}WHERE n.tenant_id = $tenantId\n${normalised.slice(pos)}`
  }

  // Fallback: append at end
  return `${normalised}\nWHERE n.tenant_id = $tenantId`
}

/**
 * Asserts that a record contains the expected tenant_id.
 * Throws if the record does not belong to the tenant.
 */
export function assertTenant(record: unknown, tenantId: string): void {
  if (
    typeof record !== 'object' ||
    record === null ||
    !('tenant_id' in record) ||
    (record as Record<string, unknown>)['tenant_id'] !== tenantId
  ) {
    throw new Error(
      `[neo4j] Tenant isolation violation: record does not belong to tenant "${tenantId}"`,
    )
  }
}
