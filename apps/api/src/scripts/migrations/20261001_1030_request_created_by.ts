/**
 * Revisione totale del 16 set 2026 · H-2: una richiesta di servizio registrava
 * chi l'ha aperta solo con la relazione `REQUESTED_BY`, e il portale elenca i
 * propri ticket per `created_by` — così una richiesta inviata dal catalogo non
 * compariva da nessuna parte. Qui la proprietà si ricava dalla relazione.
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const requestCreatedBy: Migration = {
  id:          '20261001_1030_request_created_by',
  description: 'created_by sulle richieste di servizio (da REQUESTED_BY): il portale mostra le proprie richieste',

  async up(session) {
    const res = await session.run(`
      MATCH (r:ServiceRequest)-[:REQUESTED_BY]->(u:User)
      WHERE r.created_by IS NULL
      SET r.created_by = u.id
      RETURN count(r) AS n`)
    const orphans = await session.run('MATCH (r:ServiceRequest) WHERE r.created_by IS NULL RETURN count(r) AS n')
    console.log(`[${requestCreatedBy.id}] richieste con l'autore ricostruito: ${String(res.records[0]?.get('n'))}, senza richiedente (aperte da un'integrazione): ${String(orphans.records[0]?.get('n'))}`)
  },
}
