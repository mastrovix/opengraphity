/**
 * Condizioni di transizione ITSM registrate sul workflow engine.
 *
 * L'engine non conosce il dominio: qui vivono gli evaluator (change, problem)
 * e vengono registrati all'import del modulo. Importato (side-effect) da
 * index.ts e dal walker delle auto-transizioni, così ogni processo che esegue
 * transizioni li ha. L'engine li valuta per OGNI trigger, manuale o automatico:
 * non esiste più il bypass "automatic salta le condizioni".
 */
import { workflowEngine, registerTaskCreator } from '@opengraphity/workflow'
import type { ConditionEvaluator } from '@opengraphity/workflow'
import { runQueryOne } from '../graphql/resolvers/ci-utils.js'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT } from '../lib/taskStatus.js'
import { toNumber } from '@opengraphity/neo4j'
import { areAllAssessmentsComplete } from '../lib/changeAssessments.js'
import { matchById } from '../lib/cypherLookups.js'
// Ogni processo che registra le condizioni esegue transizioni: deve anche
// pubblicare l'ingresso nei passi (workflow.step_entered).
import './stepEnteredEvents.js'

/** Missing row = the entity was not found: report 1 pending so the guard stays closed. */
function pendingCount(row: { pending?: unknown } | null | undefined): number {
  return row?.pending == null ? 1 : toNumber(row.pending)
}

export const CHANGE_CONDITIONS: Record<string, { evaluate: ConditionEvaluator; failureMessage: string }> = {
  // Problem/Incident → change_requested: serve almeno una change risolutiva
  // (RESOLVED_BY) non eliminata. Un arco qualunque o una change cancellata
  // non soddisfano la guardia.
  has_linked_change: {
    failureMessage: 'Link a change first, then request the change',
    evaluate: async (session, c) => {
      const row = await runQueryOne<{ n: unknown }>(session, `
        ${matchById('e', { labels: 'tickets', id: '$entityId' })}
        MATCH (e)-[:RESOLVED_BY]->(ch:Change {tenant_id: $tenantId})
        WHERE coalesce(ch.deleted, false) = false
        RETURN count(ch) AS n
      `, { entityId: c.entityId, tenantId: c.tenantId })
      return toNumber(row?.n) > 0
    },
  },

  /*
   * TRE task per ogni AFFECTS_CI, non due: l'assessment funzionale, quello
   * tecnico E IL PIANO di rilascio (`areAllAssessmentsComplete`).
   *
   * Il nome della condizione ne nomina solo due, e per questo etichetta e
   * messaggio di rifiuto devono nominare il piano — era l'unico posto dove la
   * verità stava scritta, e stava in un commento, dove il cliente non guarda.
   * Il difetto era già stato corretto per `all_deployments_complete`, la cui
   * etichetta dice «e le verifiche» perché anche lì le cose verificate sono
   * due: la stessa cura non era mai arrivata qui, che ne verifica tre (17 set
   * 2026). Chi disegnava un arco e scegliva «Tutti gli assessment completati»
   * lo vedeva non scattare, andava a guardare i due assessment, li trovava
   * completati, e non aveva modo di sapere che mancava il piano.
   *
   * Il NOME resta com'è: è una stringa salvata sugli archi dei workflow di
   * ogni tenant, e cambiarla vuol dire una migrazione dove un refuso
   * trasforma l'arco in un muro (vedi il commento di
   * `WORKFLOW_TRANSITION_CONDITIONS` in `packages/types`).
   */
  all_assessments_complete: {
    failureMessage: 'The assessments or the release plan are not yet complete for every CI',
    evaluate: async (session, c) => areAllAssessmentsComplete(session, c.entityId, c.tenantId),
  },

  // Tutti i deploy completati = per ogni AFFECTS_CI validation passata E
  // deployment completato.
  all_deployments_complete: {
    failureMessage: 'Validation or deployment is not yet complete for every CI',
    evaluate: async (session, c) => {
      const row = await runQueryOne<{ pending: unknown }>(session, `
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
        WITH c, count(ci) AS ciCount
        OPTIONAL MATCH (c)-[:HAS_VALIDATION]->(vt:ValidationTest)
          WHERE vt.status <> $completedStatus OR vt.result <> $passResult
        OPTIONAL MATCH (c)-[:HAS_DEPLOYMENT]->(dt:DeploymentTask)
          WHERE dt.status <> $completedStatus
        WITH ciCount, count(DISTINCT vt) + count(DISTINCT dt) AS pending
        RETURN CASE WHEN ciCount = 0 THEN 1 ELSE pending END AS pending
      `, { changeId: c.entityId, tenantId: c.tenantId, completedStatus: TASK_STATUS.COMPLETED, passResult: VALIDATION_RESULT.PASS })
      return pendingCount(row) === 0
    },
  },

  // Tutte le review confermate = per ogni AFFECTS_CI review completata con
  // esito "confirmed".
  all_reviews_confirmed: {
    failureMessage: 'Reviews are not yet confirmed for every CI',
    evaluate: async (session, c) => {
      const row = await runQueryOne<{ pending: unknown }>(session, `
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
        WITH c, count(ci) AS ciCount
        OPTIONAL MATCH (c)-[:HAS_REVIEW]->(rv:ReviewTask)
          WHERE rv.status <> $completedStatus OR rv.result <> $confirmedResult
        WITH ciCount, count(DISTINCT rv) AS pending
        RETURN CASE WHEN ciCount = 0 THEN 1 ELSE pending END AS pending
      `, { changeId: c.entityId, tenantId: c.tenantId, completedStatus: TASK_STATUS.COMPLETED, confirmedResult: REVIEW_RESULT.CONFIRMED })
      return pendingCount(row) === 0
    },
  },

  /**
   * I COMPITI DEL PASSO CHE SI STA LASCIANDO sono tutti chiusi (20 set 2026).
   *
   * È la decisione del proprietario: «il passo aspetta». Finché un compito
   * creato in quel passo è aperto o in attesa, non si esce — ed è la ragione
   * per cui esiste un compito invece di una nota: se non blocca, nessuno lo
   * chiude. Gli annullati non contano (annullare è una decisione, non un
   * lavoro rimasto), i compiti di ALTRI passi nemmeno.
   *
   * Vale per qualunque entità, non solo per le change: i compiti generici
   * sono del motore.
   */
  all_tasks_complete: {
    failureMessage: 'Some tasks of this step are still to be done',
    evaluate: async (session, c) => {
      const { compitiDaFareNelPasso } = await import('../lib/ticketTasks.js')
      return (await compitiDaFareNelPasso(session, c.tenantId, c.entityId, c.fromStepName)) === 0
    },
  },
}

/** Idempotente: registra tutte le condizioni ITSM sull'engine. */
export function registerWorkflowConditions(): void {
  for (const [name, { evaluate, failureMessage }] of Object.entries(CHANGE_CONDITIONS)) {
    workflowEngine.registerCondition(name, evaluate, failureMessage)
  }
}

registerWorkflowConditions()

/**
 * CHI SCRIVE I COMPITI, registrato qui accanto alle condizioni e per la
 * stessa ragione (20 set 2026).
 *
 * L'azione `create_task` di un passo non può prendere il suo scrittore dal
 * contesto della chiamata: tre dei cinque punti che costruiscono un
 * `ActionContext` lo costruiscono povero (l'approvazione, due cammini delle
 * change), e fra quelli c'è proprio «richiesta approvata → partono i
 * compiti». Lì il ticket sarebbe avanzato SENZA i suoi compiti, e il motore
 * raccoglie gli errori delle azioni invece di annullare la transizione,
 * quindi nessuno se ne sarebbe accorto.
 *
 * Questo modulo è importato (per effetto) da ogni processo che esegue
 * transizioni: le condizioni valgono dappertutto, e da oggi anche i compiti.
 */
registerTaskCreator(async (task) => {
  const { creaCompito } = await import('../lib/ticketTasks.js')
  return creaCompito(task)
})
