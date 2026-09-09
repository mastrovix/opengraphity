/**
 * Event Management (ondata 1) — bootstrap dei dati esistenti.
 *
 *  (a) Ogni :ConfigurationItem con `status` valorizzato e `status_source`
 *      nullo è stato impostato a mano (prima non esisteva altro modo):
 *      `status_source = 'manual'`, così il ricalcolo dal monitoraggio
 *      (eventService.recomputeCIStatus) non lo sovrascrive.
 *  (b) Ogni :Tenant senza `event_policy` riceve la policy iniziale
 *      (lib/eventPolicy.ts, DEFAULT_EVENT_POLICY_JSON). Da qui in poi una
 *      policy mancante è un errore, non un default silenzioso.
 *
 * Idempotente (filtri IS NULL): un secondo giro non tocca nulla.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_EVENT_POLICY_JSON } from '../../lib/eventPolicy.js'

export const eventManagementBootstrap: Migration = {
  id: '20260909_1000_event_management_bootstrap',
  description: 'Event Management bootstrap: status_source=manual on CIs with a status, default event_policy on tenants',
  async up(session) {
    const cis = await session.run(`
      MATCH (ci:ConfigurationItem)
      WHERE ci.status IS NOT NULL AND ci.status_source IS NULL
      SET ci.status_source = 'manual'
      RETURN count(ci) AS n
    `)
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.event_policy IS NULL
      SET t.event_policy = $policy
      RETURN count(t) AS n
    `, { policy: DEFAULT_EVENT_POLICY_JSON })
    console.log(`[${eventManagementBootstrap.id}] status_source=manual on ${String(cis.records[0]?.get('n') ?? 0)} CIs, event_policy on ${String(tenants.records[0]?.get('n') ?? 0)} tenants`)
  },
}
