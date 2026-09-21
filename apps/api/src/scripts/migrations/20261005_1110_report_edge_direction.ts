/**
 * UNA CONVENZIONE SOLA PER LA DIREZIONE DI UN ARCO DI REPORT (19 set 2026).
 *
 * `direction` vale rispetto a SORGENTE → BERSAGLIO: `outgoing` vuol dire che
 * la relazione va dalla sorgente al bersaglio. È la lettura naturale, ed è
 * quella che il generatore Cypher applica quando percorre l'arco dal lato
 * della sorgente.
 *
 * Il costruttore però ne scriveva un'altra: collegando una relazione
 * ENTRANTE metteva `direction: 'incoming'` **e** scambiava gli estremi, cioè
 * diceva due volte la stessa cosa. Finché il grafo si costruiva sempre dalla
 * radice in giù i due errori si annullavano (il generatore percorreva quegli
 * archi dal lato del bersaglio, dove la lettura era ribaltata); il
 * progettista AI, che orienta gli archi secondo il metamodello, ha prodotto
 * il caso in cui non si annullano — la relazione percorsa al contrario, e un
 * report che non trova mai niente senza dirlo.
 *
 * Qui si portano gli archi già salvati nella convenzione unica: un
 * `incoming` diventa un `outgoing` con gli estremi scambiati, che descrive la
 * STESSA relazione. Dove `direction` è già `outgoing` non si tocca niente.
 *
 * Su questa installazione non c'è nessun arco da convertire (verificato: due
 * archi in tutto, entrambi `outgoing` e con la radice come sorgente): la
 * migrazione serve alle installazioni che ne hanno.
 *
 * Idempotente: alla seconda esecuzione non trova più nessun `incoming`.
 */
import type { Migration } from '@opengraphity/neo4j'

export const reportEdgeDirection: Migration = {
  id: '20261005_1110_report_edge_direction',
  description: 'Rewrite report edges stored as "incoming" into the single source→target convention',

  async up(session) {
    const da = await session.run(`
      MATCH (a:ReportNode)-[r:REPORT_EDGE]->(b:ReportNode)
      WHERE r.direction = 'incoming'
      RETURN a.tenant_id AS tenantId, a.entity_type AS da, b.entity_type AS verso, r.relationship_type AS tipo
    `)
    if (da.records.length === 0) {
      console.log(`[${reportEdgeDirection.id}] nothing to rewrite: no report edge is stored as "incoming"`)
      return
    }
    /*
     * Si DICE cosa si riscrive prima di riscriverlo: di una conversione sui
     * report di un cliente si deve poter rispondere «questi, e nessun altro»
     * anche sei mesi dopo, leggendo un log.
     */
    for (const rec of da.records) {
      console.log(`[${reportEdgeDirection.id}] ${String(rec.get('tenantId'))}: ${String(rec.get('da'))} -[${String(rec.get('tipo'))}]-> ${String(rec.get('verso'))} — endpoints swapped, direction becomes "outgoing"`)
    }

    /*
     * La relazione si RICREA al contrario invece di cambiare le proprietà: in
     * Neo4j il verso di una relazione non si modifica, e `REPORT_EDGE` porta
     * l'ordine dei nodi nel verso stesso. Le proprietà si copiano tutte, così
     * l'id dell'arco (che il costruttore usa per riaprirlo) non cambia.
     */
    const esito = await session.run(`
      MATCH (a:ReportNode)-[r:REPORT_EDGE]->(b:ReportNode)
      WHERE r.direction = 'incoming'
      WITH a, b, r, properties(r) AS props
      CREATE (b)-[nuovo:REPORT_EDGE]->(a)
      SET nuovo = props, nuovo.direction = 'outgoing'
      DELETE r
      RETURN count(nuovo) AS n
    `)
    const n = esito.records[0]?.get('n') as { toNumber?: () => number } | number | undefined
    console.log(`[${reportEdgeDirection.id}] ${String(typeof n === 'number' ? n : (n?.toNumber?.() ?? 0))} edges rewritten`)
  },
}
