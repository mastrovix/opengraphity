/**
 * VIA I TRE INDICI DI UN'ETICHETTA CHE NON ESISTE (20 set 2026).
 *
 * `ChangeTask` è un fantasma: nessun nodo la porta, nessuna query la nomina,
 * e i task delle change hanno da tempo le cinque etichette dei loro tipi
 * (`AssessmentTask`, `DeployPlanTask`, `ValidationTest`, `DeploymentTask`,
 * `ReviewTask`). Lo stesso fantasma era già stato tolto dal contatore dei
 * task nella revisione del 14 set (CH-2) — questi tre indici erano rimasti
 * in `init.ts`, e ogni `init-schema` li ricreava.
 *
 * Non fanno danno alle prestazioni: un indice senza nodi non costa niente a
 * chi interroga. Fanno danno a chi LEGGE il database — `SHOW INDEXES`
 * racconta un modello dei dati che non c'è, e chi cerca dove stanno i task
 * di una change parte dalla pista sbagliata.
 *
 * `DROP ... IF EXISTS`: idempotente, e sulle installazioni nuove (dove
 * `init.ts` non li crea più) non trova niente.
 */
import type { Migration } from '@opengraphity/neo4j'

const INDICI = ['change_task_change', 'change_task_tenant_status', 'change_task_type']

export const dropChangeTaskIndexes: Migration = {
  id: '20261005_1120_drop_change_task_indexes',
  description: 'Drop the three indexes on the ChangeTask label, which no node carries and no query names',
  /*
   * `autocommit`: un `DROP INDEX` è una modifica dello SCHEMA, e Neo4j
   * rifiuta di scrivere un nodo nella stessa transazione — «Tried to execute
   * Write query after executing Schema modification». Dentro la transazione
   * gestita i tre indici cadevano davvero e poi il runner non riusciva più a
   * segnare la migrazione come applicata: alla riapertura ci riprovava
   * all'infinito. Qui il marcatore si scrive a parte, e `DROP ... IF EXISTS`
   * regge la seconda esecuzione.
   */
  autocommit: true,

  async up(session) {
    /*
     * Si CONTA prima di cancellare: se un giorno un'installazione avesse
     * davvero dei nodi `ChangeTask`, togliere i loro indici sarebbe un
     * peggioramento silenzioso. In quel caso la migrazione non tocca niente
     * e lo dice, invece di eseguire una decisione presa altrove su dati che
     * non conosce.
     */
    const conta = await session.run('MATCH (t:ChangeTask) RETURN count(t) AS quanti')
    const grezzo = conta.records[0]?.get('quanti') as { toNumber?: () => number } | number | undefined
    const quanti = typeof grezzo === 'number' ? grezzo : (grezzo?.toNumber?.() ?? 0)
    if (quanti > 0) {
      console.log(`[${dropChangeTaskIndexes.id}] ${quanti} :ChangeTask nodes found — indexes KEPT, nothing dropped`)
      return
    }

    for (const nome of INDICI) {
      await session.run(`DROP INDEX ${nome} IF EXISTS`)
      console.log(`[${dropChangeTaskIndexes.id}] dropped ${nome}`)
    }
  },
}
