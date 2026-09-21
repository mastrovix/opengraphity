/**
 * Verifica «Cosa resta cablato», ondata 2: la matrice di dominio
 * `service_urgency` (salute del servizio → urgenza dell'incident dei Servizi
 * monitorati) nasce per ogni tenant con i valori che il codice usava
 * (`down` → high, `degraded` → medium).
 *
 * `seedDomainMatrices` non tocca le matrici già salvate. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedDomainMatrices } from '../../lib/domainMatrixSeed.js'

export const serviceUrgencyMatrix: Migration = {
  id: '20260925_1110_service_urgency_matrix',
  description: 'Matrice di dominio service_urgency seminata per ogni tenant con i valori di prima',
  async up(session) {
    const tenants = await session.run(`MATCH (t:Tenant) RETURN t.id AS id ORDER BY id`)
    for (const r of tenants.records) {
      const tenantId = String(r.get('id'))
      const created = await seedDomainMatrices(session, tenantId)
      console.log(`[${serviceUrgencyMatrix.id}] ${tenantId}: ${created.length ? created.join(', ') : 'niente da creare'}`)
    }
  },
}
