/**
 * L'INVILUPPO DELLE FINESTRE sui piani di rilascio già scritti, più il suo
 * indice (17 set 2026).
 *
 * Il calendario delle change chiede «quali piani toccano questa settimana», e
 * le finestre stanno in un JSON: senza un estremo indicizzato sul nodo, quella
 * domanda diventa una scansione di tutti i piani del tenant a ogni apertura di
 * pagina — su un tenant con migliaia di change è inaccettabile.
 *
 * `window_start` e `window_end` sono la prima e l'ultima data fra tutte le
 * finestre del piano, validazioni comprese. Sono un INDICE, non una verità: la
 * verità resta il JSON dei passi, e da qui in avanti li scrive `saveDeployPlan`
 * nello stesso `SET` dei passi — l'unica funzione del prodotto che scrive passi
 * veri. Questa migrazione serve solo ai piani nati prima.
 *
 * Il calcolo passa da `planEnvelope`, la stessa funzione che usa la mutation:
 * rifarlo in Cypher darebbe una seconda regola su quali date valgono (offset
 * esplicito, finestre a rovescio) e nessun test la vedrebbe.
 *
 * Un piano le cui date non valgono NON prende un inviluppo: resta con le
 * proprietà a null, fuori dal calendario, e il calendario lo conta e lo dice.
 *
 * `autocommit` perché crea un indice: Neo4j rifiuta `CREATE INDEX` dentro la
 * transazione del marcatore di migrazione.
 */
import type { Migration } from '@opengraphity/neo4j'
import { parseDeploySteps, planEnvelope } from '../../lib/deployWindows.js'

export const deployPlanWindowEnvelope: Migration = {
  id: '20261005_1030_deploy_plan_window_envelope',
  description: 'Deploy plans: write the window envelope (window_start/window_end) and index it, for the change calendar',
  autocommit: true,
  async up(session) {
    await session.run(`
      CREATE INDEX deploy_plan_window IF NOT EXISTS
      FOR (dp:DeployPlanTask) ON (dp.tenant_id, dp.window_start)
    `)

    const rows = await session.run(`
      MATCH (dp:DeployPlanTask)
      WHERE coalesce(dp.steps, '[]') <> '[]' AND dp.window_start IS NULL
      RETURN dp.id AS id, dp.steps AS steps
    `)

    let scritti = 0
    let senzaDate = 0
    for (const rec of rows.records) {
      const id = rec.get('id') as string
      let inviluppo: { start: string; end: string } | null = null
      try {
        inviluppo = planEnvelope(parseDeploySteps(rec.get('steps')))
      } catch {
        // Un JSON che non si apre non è un inviluppo mancante per sbaglio: il
        // piano resta fuori dal calendario, che lo conta fra gli illeggibili.
        inviluppo = null
      }
      if (!inviluppo) { senzaDate += 1; continue }
      await session.run(`
        MATCH (dp:DeployPlanTask {id: $id})
        SET dp.window_start = $start, dp.window_end = $end
      `, { id, start: inviluppo.start, end: inviluppo.end })
      scritti += 1
    }
    console.log(`[${deployPlanWindowEnvelope.id}] ${scritti} piani con inviluppo scritto, ${senzaDate} senza date utilizzabili (restano fuori dal calendario, che li conta)`)
  },
}
