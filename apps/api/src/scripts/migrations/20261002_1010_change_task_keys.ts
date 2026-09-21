/**
 * Revisione totale del 16 set 2026 · B-8: i task creati alla NASCITA di una
 * change non avevano `change_key`, la chiave su cui `addCIToChange` fa MERGE.
 * Quel MERGE non li trovava, quindi ri-aggiungere un CI già collegato (due
 * click sul pulsante «Aggiungi») creava un SECONDO assessment owner, uno
 * support e un piano di deploy per lo stesso CI: la change non usciva più
 * dall'analisi, perché la guardia aspettava i duplicati, e la pagina ne
 * mostrava uno solo.
 *
 * Qui la chiave si ricostruisce per i task già esistenti, nella forma esatta
 * che il MERGE usa: `<changeId>-<ciId>-<ruolo>`. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const changeTaskKeys: Migration = {
  id:          '20261002_1010_change_task_keys',
  description: 'change_key sugli assessment e sui piani di deploy creati alla nascita della change (B-8: ri-aggiungere un CI creava task doppi)',

  async up(session) {
    const owner = await session.run(`
      MATCH (c:Change)-[:HAS_ASSESSMENT]->(t:AssessmentTask)
      WHERE t.change_key IS NULL AND t.ci_id IS NOT NULL AND t.responder_role IS NOT NULL
      SET t.change_key = c.id + '-' + t.ci_id + '-' + t.responder_role
      RETURN count(t) AS n`)
    const plans = await session.run(`
      MATCH (c:Change)-[:HAS_DEPLOY_PLAN]->(t:DeployPlanTask)
      WHERE t.change_key IS NULL AND t.ci_id IS NOT NULL
      SET t.change_key = c.id + '-' + t.ci_id + '-deployplan'
      RETURN count(t) AS n`)
    // I duplicati già creati NON si cancellano da una migrazione: portano
    // risposte e punteggi, e sceglierne uno è una decisione del cliente. Si
    // contano, così l'operatore sa dove guardare.
    const dup = await session.run(`
      MATCH (c:Change)-[:HAS_ASSESSMENT]->(t:AssessmentTask)
      WITH c.id AS changeId, t.ci_id AS ciId, t.responder_role AS role, count(t) AS n
      WHERE n > 1
      RETURN count(*) AS groups, sum(n - 1) AS extra`)
    const g = dup.records[0]
    console.log(`[${changeTaskKeys.id}] change_key ricostruita: ${String(owner.records[0]?.get('n'))} assessment, ${String(plans.records[0]?.get('n'))} piani di deploy. Gruppi con task duplicati (non toccati): ${String(g?.get('groups') ?? 0)}, task in più: ${String(g?.get('extra') ?? 0)}`)
  },
}
