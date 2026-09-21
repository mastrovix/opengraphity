/**
 * La destinazione di una relazione del metamodello in una forma sola: l'etichetta
 * Neo4j del tipo (`Server`) o `any` (revisione del 15 set 2026 · CM-1).
 *
 * Il disegnatore salvava il NOME del tipo (`server`), mentre chi crea gli archi
 * fra CI confronta con le etichette, come fanno le relazioni spedite col
 * prodotto: una relazione del cliente non combaciava mai. Qui le definizioni
 * già salvate col nome passano all'etichetta. Idempotente: una definizione con
 * l'etichetta o con `any` non combacia col nome di nessun tipo e resta com'è.
 */
import type { Migration } from '@opengraphity/neo4j'

export const ciRelationTargetLabel: Migration = {
  id: '20260929_1000_ci_relation_target_label',
  description: 'CIRelationDefinition.target_type dal nome del tipo alla sua etichetta Neo4j',
  async up(session) {
    const r = await session.run(`
      MATCH (:CITypeDefinition)-[:HAS_RELATION]->(rel:CIRelationDefinition)
      WHERE rel.target_type IS NOT NULL AND rel.target_type <> 'any'
      MATCH (target:CITypeDefinition)
      WHERE target.name = rel.target_type AND target.neo4j_label IS NOT NULL
        AND target.neo4j_label <> rel.target_type
        AND (target.tenant_id = 'system' OR target.tenant_id = rel.tenant_id)
      SET rel.target_type = target.neo4j_label
      RETURN collect(coalesce(rel.tenant_id, 'system') + '/' + rel.name + ' → ' + target.neo4j_label) AS changed
    `)
    const changed = (r.records[0]?.get('changed') as string[] | undefined) ?? []
    console.log(`[${ciRelationTargetLabel.id}] ${changed.length ? changed.join(', ') : 'nessuna definizione da aggiornare'}`)
  },
}
