/**
 * Sezioni di report salvate col nodo di raggruppamento sbagliato.
 *
 * Fino al 14 set 2026 `createSectionWithNodesEdges` salvava il nodo con un
 * uuid nuovo e la sezione con `group_by_node_id` = l'id del client (che sul
 * nodo resta come `temp_id`). Il loader restituisce i nodi con l'uuid, quindi
 * ogni sezione creata, modificata o duplicata falliva al Run con «stale report
 * config». Qui si ricollega la sezione al nodo giusto: quello della STESSA
 * sezione il cui `temp_id` è il valore ricordato, e solo quando nessun nodo ha
 * già quell'id (una sezione sana non si tocca).
 */
import type { Migration } from '@opengraphity/neo4j'

export const reportSectionGroupNode: Migration = {
  id:          '20260922_1000_report_section_group_node',
  description: 'ReportSection.group_by_node_id: dall\'id del client (temp_id) all\'id del nodo salvato',

  async up(session) {
    const r = await session.run(
      `MATCH (s:ReportSection)-[:HAS_NODE]->(n:ReportNode)
       WHERE s.group_by_node_id IS NOT NULL
         AND n.temp_id = s.group_by_node_id
         AND NOT EXISTS { MATCH (s)-[:HAS_NODE]->(:ReportNode {id: s.group_by_node_id}) }
       SET s.group_by_node_id = n.id
       RETURN count(s) AS n`,
    )
    console.log(`[20260922_1000] sezioni ricollegate al nodo salvato: ${Number(r.records[0]?.get('n') ?? 0)}`)
  },
}
