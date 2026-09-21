/**
 * Revisione del 14 set 2026 · CH-3 ed EV-3: le matrici `environment_risk` (ambiente del
 * CI → punteggio 0..3 dell'assessment della change) e `ci_health` (severità
 * dell'allarme → salute del CI) nascono per ogni tenant con i valori che il
 * codice usava (`production` 3, `staging` 1, gli altri 0; `critical` → down,
 * `warning` → degraded, `info` → operational).
 *
 * `seedDomainMatrices` non tocca le matrici già salvate, quindi qui crea solo
 * quelle nuove. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedDomainMatrices } from '../../lib/domainMatrixSeed.js'

export const environmentRiskMatrix: Migration = {
  id: '20260924_1010_environment_risk_matrix',
  description: 'Matrici di dominio environment_risk e ci_health seminate per ogni tenant con i valori di prima',
  async up(session) {
    const tenants = await session.run(`MATCH (t:Tenant) RETURN t.id AS id ORDER BY id`)
    for (const r of tenants.records) {
      const tenantId = String(r.get('id'))
      const created = await seedDomainMatrices(session, tenantId)
      console.log(`[${environmentRiskMatrix.id}] ${tenantId}: ${created.length ? created.join(', ') : 'niente da creare'}`)
    }
  },
}
