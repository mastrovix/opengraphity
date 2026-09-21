/**
 * Dalle regole «tipi di CI ammessi» alle esclusioni per tipo di ticket
 * (revisione del 15 set 2026 · CM-8, decisione del proprietario).
 *
 * Le `ITILCIRelationRule` elencavano i tipi ammessi con un tipo di relazione e
 * una direzione che nessuno leggeva, e valevano solo aggiungendo un CI a
 * incident e problem già aperti. Il proprietario ha scelto di partire SENZA
 * esclusioni: le vecchie regole si cancellano, e l'amministratore dichiara le
 * esclusioni (`TicketCIExclusion`) dove servono. Si toglie anche la proprietà
 * `relation_type` dai collegamenti incident/problem → CI, che quelle regole
 * scrivevano e nessuno leggeva. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const ticketCIExclusions: Migration = {
  id: '20260929_1010_ticket_ci_exclusions',
  description: 'Cancella le ITILCIRelationRule (si parte senza esclusioni) e relation_type dai collegamenti ticket → CI',
  async up(session) {
    const rules = await session.run(`
      MATCH (r:ITILCIRelationRule)
      WITH r, r.tenant_id + '/' + r.itil_type + '→' + r.ci_type AS what
      DETACH DELETE r
      RETURN collect(what) AS deleted
    `)
    const deleted = (rules.records[0]?.get('deleted') as string[] | undefined) ?? []
    const edges = await session.run(`
      MATCH (:Incident|Problem)-[e:AFFECTED_BY|AFFECTS]->()
      WHERE e.relation_type IS NOT NULL OR 'relation_type' IN keys(e)
      REMOVE e.relation_type
      RETURN count(e) AS n
    `)
    console.log(`[${ticketCIExclusions.id}] regole cancellate: ${deleted.length ? deleted.join(', ') : 'nessuna'}; collegamenti ripuliti: ${String(edges.records[0]?.get('n'))}`)
  },
}
