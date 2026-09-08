/**
 * Condizioni di transizione ITSM registrate sul workflow engine.
 *
 * L'engine non conosce il dominio: qui vivono gli evaluator (change, problem)
 * e vengono registrati all'import del modulo. Importato (side-effect) da
 * index.ts e dal walker delle auto-transizioni, così ogni processo che esegue
 * transizioni li ha. L'engine li valuta per OGNI trigger, manuale o automatico:
 * non esiste più il bypass "automatic salta le condizioni".
 */
import { workflowEngine } from '@opengraphity/workflow'
import type { ConditionEvaluator } from '@opengraphity/workflow'
import { runQueryOne } from '../graphql/resolvers/ci-utils.js'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT } from '../lib/taskStatus.js'
import { toNumber } from '@opengraphity/neo4j'

/** Missing row = the entity was not found: report 1 pending so the guard stays closed. */
function pendingCount(row: { pending?: unknown } | null | undefined): number {
  return row?.pending == null ? 1 : toNumber(row.pending)
}

export const CHANGE_CONDITIONS: Record<string, { evaluate: ConditionEvaluator; failureMessage: string }> = {
  // Problem/Incident → change_requested: serve almeno una change risolutiva
  // (RESOLVED_BY) non eliminata. Un arco qualunque o una change cancellata
  // non soddisfano la guardia.
  has_linked_change: {
    failureMessage: 'Collega prima una change, poi richiedi la change',
    evaluate: async (session, c) => {
      const row = await runQueryOne<{ n: unknown }>(session, `
        MATCH (e {id: $entityId, tenant_id: $tenantId})-[:RESOLVED_BY]->(ch:Change {tenant_id: $tenantId})
        WHERE coalesce(ch.deleted, false) = false
        RETURN count(ch) AS n
      `, { entityId: c.entityId, tenantId: c.tenantId })
      return toNumber(row?.n) > 0
    },
  },

  // Tutti gli assessment completati = per ogni AFFECTS_CI della change i task
  // Functional, Technical e Planning sono 'completed'.
  all_assessments_complete: {
    failureMessage: 'Assessment non ancora completati per tutti i CI',
    evaluate: async (session, c) => {
      const row = await runQueryOne<{ pending: unknown }>(session, `
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
        WITH c, count(ci) AS ciCount
        OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(at:AssessmentTask)
          WHERE at.status <> $completedStatus
        OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask)
          WHERE dp.status <> $completedStatus
        WITH ciCount, count(DISTINCT at) + count(DISTINCT dp) AS pending
        RETURN CASE WHEN ciCount = 0 THEN 1 ELSE pending END AS pending
      `, { changeId: c.entityId, tenantId: c.tenantId, completedStatus: TASK_STATUS.COMPLETED })
      return pendingCount(row) === 0
    },
  },

  // Tutti i deploy completati = per ogni AFFECTS_CI validation passata E
  // deployment completato.
  all_deployments_complete: {
    failureMessage: 'Validation o deployment non ancora completati per tutti i CI',
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
    failureMessage: 'Review non ancora confermate per tutti i CI',
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
}

/** Idempotente: registra tutte le condizioni ITSM sull'engine. */
export function registerWorkflowConditions(): void {
  for (const [name, { evaluate, failureMessage }] of Object.entries(CHANGE_CONDITIONS)) {
    workflowEngine.registerCondition(name, evaluate, failureMessage)
  }
}

registerWorkflowConditions()
