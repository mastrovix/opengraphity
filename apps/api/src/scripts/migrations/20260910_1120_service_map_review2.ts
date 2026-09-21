/**
 * Servizi monitorati (revisione 2, ondata 1) — `stale_reason` sulle mappe già
 * marcate «da rivedere», e verifica di `health_if_active`.
 *
 * Due campi nuovi. In Neo4j «null» e «assente» sono la stessa cosa, quindi non
 * c'è nulla da scrivere per portarli a null: l'unica cosa che una migrazione
 * può fare davvero è **recuperare il motivo** delle mappe già `stale`, che
 * altrimenti resterebbero senza finché il motore non le rivaluta.
 *
 *  - `stale_reason` (`missing_ci` | `over_limit`): per le mappe con
 *    `stale = true` e nessun motivo si guarda il grafo — se almeno un id di
 *    `node_ids` non ha più la sua `INCLUDES`, il motivo è `missing_ci`
 *    (un componente cancellato dalla CMDB); altrimenti resta la
 *    sincronizzazione rifiutata dal tetto dei 500, cioè `over_limit`. È lo
 *    stesso criterio del motore (`loadServiceMapState`), applicato una volta.
 *  - `health_if_active` (la salute che il servizio avrebbe senza la finestra di
 *    change): non si può ricalcolare qui senza rifare tutto il motore, e
 *    inventarla sarebbe peggio che non averla. La scrive la prima valutazione
 *    (entro 10 minuti, passata periodica): la migrazione si limita a contare
 *    quante mappe `maintenance` la aspettano ancora.
 *
 * Idempotente: alla seconda esecuzione nessuna mappa `stale` è senza motivo.
 * Non tocca `stale`, `health` né `version`: non è una modifica di
 * configurazione.
 */
import type { Migration } from '@opengraphity/neo4j'

export const serviceMapReview2: Migration = {
  id: '20260910_1120_service_map_review2',
  description: 'Servizi monitorati (revisione 2): backfill ServiceMap.stale_reason on already stale maps (missing_ci vs over_limit)',
  async up(session) {
    const result = await session.run(`
      MATCH (m:ServiceMap)
      WHERE m.stale = true AND m.stale_reason IS NULL
      WITH m, [(m)-[:INCLUDES]->(ci) | ci.id] AS includedIds
      WITH m, any(x IN coalesce(m.node_ids, []) WHERE NOT x IN includedIds) AS hasMissing
      SET m.stale_reason = CASE WHEN hasMissing THEN 'missing_ci' ELSE 'over_limit' END
      RETURN count(m) AS n, sum(CASE WHEN hasMissing THEN 1 ELSE 0 END) AS missing
    `)
    const written = Number(result.records[0]?.get('n') ?? 0)
    const missing = Number(result.records[0]?.get('missing') ?? 0)

    const total = await session.run(`
      MATCH (m:ServiceMap)
      RETURN count(m) AS n,
             sum(CASE WHEN m.stale = true THEN 1 ELSE 0 END) AS stale,
             sum(CASE WHEN m.health = 'maintenance' AND m.health_if_active IS NULL THEN 1 ELSE 0 END) AS pendingIfActive
    `)
    const maps  = Number(total.records[0]?.get('n') ?? 0)
    const stale = Number(total.records[0]?.get('stale') ?? 0)
    const pendingIfActive = Number(total.records[0]?.get('pendingIfActive') ?? 0)

    console.log(`[${serviceMapReview2.id}] ${maps} ServiceMap, ${stale} stale: stale_reason written on ${written} (${missing} missing_ci, ${written - missing} over_limit); ${pendingIfActive} maintenance maps still waiting for health_if_active (next evaluation)`)
  },
}
