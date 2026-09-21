/**
 * Verifica «Cosa resta cablato», ondata 1 (scelta del proprietario): la
 * priorità di una richiesta dal catalogo la decide la VOCE del catalogo. Il
 * portale mandava `medium` scritto nel codice.
 *
 * Il primo giorno non cambia niente: le voci esistenti ricevono `medium`, cioè
 * la priorità con cui le loro richieste nascevano — ma solo se il vocabolario
 * `priority` del cliente ha ancora quel valore. Altrimenti la voce resta senza
 * priorità, lo si dice, e la diagnostica la segnala finché l'amministratore non
 * la sceglie.
 *
 * Idempotente: non tocca le voci che hanno già una priorità.
 */
import type { Migration } from '@opengraphity/neo4j'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'

const tag = '[20260925_1030_catalog_item_priority]'
/** La priorità che il portale scriveva per ogni richiesta dal catalogo (ServiceCatalogPage). */
const PORTAL_FACTORY_PRIORITY = 'medium'

export const catalogItemPriority: Migration = {
  id: '20260925_1030_catalog_item_priority',
  description: 'ServiceCatalogItem.priority: la priorità delle richieste dalla voce, seminata con medium',
  async up(session) {
    const rows = await session.run(`
      MATCH (ci:ServiceCatalogItem) WHERE ci.priority IS NULL
      OPTIONAL MATCH (own:EnumTypeDefinition {name: 'priority', tenant_id: ci.tenant_id})
      OPTIONAL MATCH (shipped:EnumTypeDefinition {name: 'priority', tenant_id: $systemTenant})
      WITH ci, coalesce(own.values, shipped.values, []) AS values
      WITH ci.tenant_id AS tenant, $value IN values AS available, collect(ci) AS items
      FOREACH (i IN CASE WHEN available THEN items ELSE [] END | SET i.priority = $value)
      RETURN tenant, available, size(items) AS n
    `, { systemTenant: SYSTEM_TENANT, value: PORTAL_FACTORY_PRIORITY })
    for (const r of rows.records) {
      const tenant = String(r.get('tenant'))
      const n = String(r.get('n'))
      console.log(r.get('available') === true
        ? `${tag} ${tenant}: ${n} voci del catalogo con priorità ${PORTAL_FACTORY_PRIORITY}`
        : `${tag} ${tenant}: il vocabolario priority non ha ${PORTAL_FACTORY_PRIORITY} — ${n} voci restano senza priorità, da scegliere in Admin → Service catalog`)
    }
  },
}
