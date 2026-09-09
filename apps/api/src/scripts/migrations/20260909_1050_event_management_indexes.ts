/**
 * Event Management (revisione, ondata 1) — chiave di ricerca per nome dei CI.
 *
 * Il riconoscimento del CI negli allarmi (services/eventService.ts#matchCI)
 * cerca `ConfigurationItem.name_key` = nome minuscolo, indicizzato da
 * `ci_tenant_name_key` (packages/neo4j/src/init.ts: gli indici — anche
 * `event_tenant_source` e `event_tenant_correlation` — vivono lì, sorgente
 * unica dello schema). Qui il backfill dei CI già presenti:
 * `name_key = toLower(name)` dove manca o non combacia più con il nome.
 *
 * Idempotente: a lotti di BATCH nodi finché non ne restano; un secondo
 * passaggio non tocca nulla. Da qui in poi `name_key` la scrivono i resolver
 * che creano/rinominano CI (lib/ciNameKey.ts elenca dove).
 */
import type { Migration } from '@opengraphity/neo4j'

export const NAME_KEY_BACKFILL_BATCH = 5000

export const eventManagementIndexes: Migration = {
  id: '20260909_1050_event_management_indexes',
  description: 'Event Management: backfill ConfigurationItem.name_key = toLower(name) (indexed by ci_tenant_name_key) for CI name matching of monitoring events',
  async up(session) {
    let total = 0
    let batches = 0
    for (;;) {
      const res = await session.run(`
        MATCH (ci:ConfigurationItem)
        WHERE ci.name IS NOT NULL AND (ci.name_key IS NULL OR ci.name_key <> toLower(ci.name))
        WITH ci LIMIT toInteger($batch)
        SET ci.name_key = toLower(ci.name)
        RETURN count(ci) AS n
      `, { batch: NAME_KEY_BACKFILL_BATCH })
      const n = Number(res.records[0]?.get('n') ?? 0)
      total += n
      if (n > 0) batches++
      if (n < NAME_KEY_BACKFILL_BATCH) break
    }
    console.log(`[${eventManagementIndexes.id}] ConfigurationItem.name_key backfilled on ${total} CI in ${batches} batch(es)`)
  },
}
