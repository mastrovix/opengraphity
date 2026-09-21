/**
 * Giro nel browser del 14 set 2026 (#43): il motore del workflow non scriveva
 * `published_at` quando un articolo entrava nel passo di pubblicazione, e ogni
 * articolo pubblicato diceva «Published: —». Da ora lo scrive il motore; qui si
 * recupera la data degli articoli GIÀ pubblicati: l'ingresso nel passo corrente
 * (categoria `published`) dalla storia del workflow.
 *
 * Un articolo senza quella voce di storia (importato, o nato prima della
 * storia dei passi) prende `updated_at`, e il conteggio lo DICE nel log.
 * Idempotente: tocca solo gli articoli pubblicati senza data.
 */
import type { Migration } from '@opengraphity/neo4j'

export const kbPublishedAt: Migration = {
  id: '20260924_1040_kb_published_at',
  description: 'Data di pubblicazione sugli articoli KB già pubblicati (dall\'ingresso nel passo)',
  async up(session) {
    const r = await session.run(`
      MATCH (a:KBArticle)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep {category: 'published'})
      WHERE a.published_at IS NULL
      OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(e:WorkflowStepExecution {step_name: s.name})
      WITH a, max(e.entered_at) AS entered
      SET a.published_at = coalesce(entered, a.updated_at, a.created_at)
      RETURN count(a) AS total, sum(CASE WHEN entered IS NULL THEN 1 ELSE 0 END) AS withoutHistory
    `)
    const rec = r.records[0]
    const total = Number(rec?.get('total') ?? 0)
    const withoutHistory = Number(rec?.get('withoutHistory') ?? 0)
    console.log(`[${kbPublishedAt.id}] articoli datati: ${total}; senza storia del passo (data = ultimo aggiornamento): ${withoutHistory}`)
  },
}
