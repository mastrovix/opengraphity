/**
 * Owner's decision of 24 Sep 2026: declaring a Major Incident raises its
 * priority. The domain matrix `major_incident_priority` (declared → the
 * customer's priority) is seeded for every tenant with `critical`, and the
 * customer may change it in Settings → Domain matrices.
 *
 * `seedDomainMatrices` does not touch the matrices already saved. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedDomainMatrices } from '../../lib/domainMatrixSeed.js'

export const majorIncidentPriorityMatrix: Migration = {
  id: '20261011_1010_major_incident_priority_matrix',
  description: 'Domain matrix major_incident_priority seeded for every tenant (declared → critical)',
  async up(session) {
    const tenants = await session.run(`MATCH (t:Tenant) RETURN t.id AS id ORDER BY id`)
    for (const r of tenants.records) {
      const tenantId = String(r.get('id'))
      const created = await seedDomainMatrices(session, tenantId)
      console.log(`[${majorIncidentPriorityMatrix.id}] ${tenantId}: ${created.length ? created.join(', ') : 'nothing to create'}`)
    }
  },
}
