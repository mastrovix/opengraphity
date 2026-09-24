/**
 * Tour of 24 Sep 2026 (G35): the status of a server offered «Expired» and
 * «Revoked» — the lifecycle of a certificate — because one vocabulary serves
 * every type. A type now says which values it does not offer
 * (`status_excluded`); the types shipped with the product that are not
 * certificates do not offer those two.
 *
 * Only the shipped types (tenant `system`), and only where nothing was said
 * yet: a customer's own types offer every value until the customer chooses.
 * Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'

/** The values of the lifecycle that belong to a certificate only. */
export const CERTIFICATE_ONLY_STATUSES = ['expired', 'revoked'] as const

export const ciTypeStatusExcluded: Migration = {
  id: '20261011_1040_ci_type_status_excluded',
  description: 'Shipped CI types other than certificate do not offer the statuses expired and revoked',
  async up(session) {
    const res = await session.run(`
      MATCH (t:CITypeDefinition {tenant_id: 'system'})
      WHERE t.scope = 'base' AND t.status_excluded IS NULL AND NOT t.name IN ['certificate', '__base__']
      SET t.status_excluded = $excluded
      RETURN count(t) AS n
    `, { excluded: JSON.stringify(CERTIFICATE_ONLY_STATUSES) })
    console.log(`[${ciTypeStatusExcluded.id}] types updated: ${String(res.records[0]?.get('n') ?? 0)}`)
  },
}
