/**
 * Un articolo KB è pubblicato quando la sua istanza di workflow sta in un passo
 * di **categoria** `published` — non quando il suo stato si chiama «published».
 *
 * Il passo ha un nome del cliente (lo rinomina dal disegnatore) e una categoria
 * del prodotto. Liste, portale e REST già guardavano la categoria; i
 * suggerimenti per somiglianza e l'assistente filtravano su
 * `status = 'published'`, quindi con il passo rinominato restavano vuoti senza
 * dire perché (verifica «Cosa resta cablato», ondata 1).
 */
export function kbArticlePublishedCypher(variable: string): string {
  return `EXISTS { MATCH (${variable})-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(:WorkflowStep {category: 'published'}) }`
}
