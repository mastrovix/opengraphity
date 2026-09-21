/**
 * Giro nel browser del 14 set 2026 (#32): il peso dell'ambiente nel punteggio
 * dell'assessment della change diventa dato del cliente
 * (`Tenant.change_environment_weight`, lib/changeEnvironmentWeight.ts). Qui si
 * scrive esplicito il valore che il codice usava, 5, così nessun punteggio
 * cambia il primo giorno: tararlo è una scelta dell'amministratore, dalla
 * pagina Matrici di dominio. Un valore già scelto non si tocca. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { FACTORY_ENVIRONMENT_WEIGHT } from '../../lib/changeEnvironmentWeight.js'

export const changeEnvironmentWeightSeed: Migration = {
  id: '20260924_1050_change_environment_weight',
  description: 'Tenant.change_environment_weight: il peso dell\'ambiente nel rischio della change diventa configurabile, seminato col 5 di prima',
  async up(session) {
    const r = await session.run(`
      MATCH (t:Tenant) WHERE t.change_environment_weight IS NULL
      SET t.change_environment_weight = $weight, t.updated_at = $now
      RETURN collect(t.id) AS tenants
    `, { weight: FACTORY_ENVIRONMENT_WEIGHT, now: new Date().toISOString() })
    const tenants = (r.records[0]?.get('tenants') as string[] | undefined) ?? []
    console.log(`[${changeEnvironmentWeightSeed.id}] peso ${String(FACTORY_ENVIRONMENT_WEIGHT)} su: ${tenants.length ? tenants.join(', ') : 'nessuno'}`)
  },
}
