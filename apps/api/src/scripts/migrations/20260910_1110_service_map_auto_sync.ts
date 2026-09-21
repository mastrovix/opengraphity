/**
 * Servizi monitorati (ondata 5) — `ServiceMap.auto_sync` sulle mappe esistenti.
 *
 * Dall'ondata 5 la mappa del servizio è **viva**: si aggiorna da sola quando
 * cambia la CMDB, e un interruttore per mappa (`auto_sync`) la congela. Le
 * mappe create prima non hanno la proprietà, e nessuno la inventa a runtime
 * (`assertAutoSync` in services/serviceImpact/config.ts fallisce nominando
 * questa migrazione): una mappa che si crede congelata mentre si aggiorna da
 * sola — o il contrario — è il peggio che possa capitare qui.
 *
 * Scrive `auto_sync = true` (il nuovo default: la decisione dell'ondata 5 è
 * che la mappa viva è il comportamento normale) SOLO dove manca, e lascia
 * `synced_at` a null: la mappa non è ancora stata sincronizzata da nessuno, e
 * la prima passata (o la prima scrittura CMDB) la porta in pari.
 *
 * Idempotente: alla seconda esecuzione non c'è più nessuna mappa senza
 * `auto_sync`. Un interruttore già spento a mano non viene riacceso.
 */
import type { Migration } from '@opengraphity/neo4j'

export const serviceMapAutoSync: Migration = {
  id: '20260910_1110_service_map_auto_sync',
  description: 'Servizi monitorati: write ServiceMap.auto_sync = true where missing (live map is the new default), leaving synced_at null',
  async up(session) {
    const now = new Date().toISOString()
    const result = await session.run(`
      MATCH (m:ServiceMap)
      WHERE m.auto_sync IS NULL
      SET m.auto_sync = true, m.updated_at = $now
      RETURN count(m) AS n
    `, { now })
    const written = Number(result.records[0]?.get('n') ?? 0)

    const total = await session.run(`
      MATCH (m:ServiceMap)
      RETURN count(m) AS n, sum(CASE WHEN m.auto_sync = true THEN 1 ELSE 0 END) AS live
    `)
    const maps = Number(total.records[0]?.get('n') ?? 0)
    const live = Number(total.records[0]?.get('live') ?? 0)

    console.log(`[${serviceMapAutoSync.id}] ${maps} ServiceMap: auto_sync written ${written}, live now ${live}, frozen ${maps - live}`)
  },
}
