/**
 * Personalizzazioni, ondata 2 (A2-2 / B-15) — i passi seminati che finiscono
 * in fondo alla barra delle fasi.
 *
 * `20260908_1000_workflow_step_metadata` derivava `step_order` dai NOMI di
 * fabbrica con default 99, e la sua tabella non conosceva né `known_error`
 * (problem) né i nomi veri del workflow Service Request (`submitted`,
 * `approval`, `fulfilled`, `rejected`): quei cinque passi sono rimasti a 99.
 * Dal vivo, su c-one, sono esattamente:
 *   problem/`known_error` = 99
 *   service_request/`submitted` (che è il passo INIZIALE), `approval`,
 *   `fulfilled`, `rejected` = 99
 * con `in_progress` = 3 e `closed` = 6 — cioè il passo iniziale mostrato dopo
 * quello di chiusura in `PhaseChipBar` e in ogni lista ordinata per `order`.
 *
 * Questa migrazione riporta i passi di fabbrica di quelle DUE definizioni
 * seminate all'ordine vero delle transizioni:
 *   problem:          new → under_investigation → known_error → change_requested
 *                     → change_in_progress → resolved → deferred → rejected → closed
 *   service_request:  submitted → approval → in_progress → fulfilled → closed → rejected
 * che è lo stesso ordine oggi dichiarato dai seed (packages/workflow/src/seed-problem.ts,
 * scripts/lib/workflowDefinitions.ts): seed e migrazione dicono la stessa cosa.
 *
 * Che cosa NON tocca:
 *   - le definizioni con un nome diverso da quello di fabbrica (copie e
 *     processi del cliente);
 *   - dentro quelle due definizioni, i passi con un nome che il seed non
 *     conosce — cioè i passi aggiunti dall'amministratore, che restano dove
 *     sono (vedi B-3: da questa ondata `addWorkflowStep` scrive `step_order`);
 *   - incident, change e kb_article, che non hanno passi a 99.
 *
 * Idempotente: scrive solo dove il valore è diverso, e stampa riga per riga
 * quello che cambia.
 */
import type { Migration } from '@opengraphity/neo4j'

/** (entity_type, nome definizione di fabbrica) → nome passo → ordine. */
const SEEDED_ORDER: { entityType: string; definition: string; order: Record<string, number> }[] = [
  {
    entityType: 'problem',
    definition: 'Problem Management',
    order: {
      new: 1, under_investigation: 2, known_error: 3, change_requested: 4,
      change_in_progress: 5, resolved: 6, deferred: 7, rejected: 8, closed: 9,
    },
  },
  {
    entityType: 'service_request',
    definition: 'Service Request Fulfillment',
    order: { submitted: 1, approval: 2, in_progress: 3, fulfilled: 4, closed: 5, rejected: 6 },
  },
]

export const workflowStepOrderSeeded: Migration = {
  id: '20260913_1400_workflow_step_order_seeded',
  description: 'WorkflowStep: step_order dei workflow problem/service_request seminati riportato all\'ordine delle transizioni (i passi del cliente restano)',
  async up(session) {
    let total = 0
    for (const spec of SEEDED_ORDER) {
      const res = await session.run(`
        MATCH (wd:WorkflowDefinition {entity_type: $entityType, name: $definition})-[:HAS_STEP]->(s:WorkflowStep)
        WITH wd, s, $order[s.name] AS wanted
        WHERE wanted IS NOT NULL AND (s.step_order IS NULL OR s.step_order <> wanted)
        SET s.step_order = wanted
        RETURN wd.tenant_id AS tenant, s.name AS step, wanted AS newOrder
        ORDER BY tenant, newOrder
      `, { entityType: spec.entityType, definition: spec.definition, order: spec.order })
      for (const r of res.records) {
        console.log(`[${workflowStepOrderSeeded.id}] ${String(r.get('tenant'))} / "${spec.definition}" / ${String(r.get('step'))}: step_order → ${String(r.get('newOrder'))}`)
      }
      total += res.records.length
    }
    console.log(`[${workflowStepOrderSeeded.id}] ${String(total)} passi riordinati (0 = già a posto)`)
  },
}
