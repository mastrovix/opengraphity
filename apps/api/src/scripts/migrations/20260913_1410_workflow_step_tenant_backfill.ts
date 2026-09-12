/**
 * Personalizzazioni, ondata 2 (B2-1 / B-3) — i passi creati dal disegnatore
 * nascevano SENZA `tenant_id`.
 *
 * `addWorkflowStep` creava il nodo con id/definition_id/name/label/type e basta:
 * niente `tenant_id`, niente `is_initial`/`is_terminal`/`is_open`/`category`/
 * `step_order`. Chi filtra il passo per tenant non lo trovava più —
 * `updateWorkflowStep` rispondeva «WorkflowStep non trovato», `removeWorkflowStep`
 * «Cannot remove step», e `loadTransitionRows` non caricava gli archi in USCITA
 * dal passo nuovo: una regola che il motore percorreva e che l'amministratore
 * non vedeva nel disegnatore. Da questa ondata la mutation scrive tutto; qui si
 * rimette a posto quello che è già nel grafo.
 *
 * Cosa completa, SOLO dove il dato manca (mai una sovrascrittura di una scelta
 * del cliente):
 *   - `tenant_id` ← quello della definizione che possiede il passo;
 *   - `is_initial`/`is_terminal`/`is_open` ← dal `type` (start/end), la stessa
 *     regola di `getInitialStepName` (`coalesce(is_initial, type = 'start')`);
 *   - `category` ← `closed` se terminale, `active` altrimenti: il ripiego della
 *     migrazione dei metadata (20260908_1000);
 *   - `step_order` ← in coda ai passi della definizione che un ordine ce l'hanno.
 *
 * Idempotente: alla seconda esecuzione non c'è più niente da completare e non si
 * scrive. Fail-loud: un passo appeso a NESSUNA definizione non può ereditare un
 * tenant da nessuna parte — la migrazione si ferma nominandolo invece di
 * inventarne uno.
 */
import type { Migration } from '@opengraphity/neo4j'

export const workflowStepTenantBackfill: Migration = {
  id: '20260913_1410_workflow_step_tenant_backfill',
  description: 'Personalizzazioni (ondata 2, B2-1): backfill tenant_id e metadata sui WorkflowStep creati dal disegnatore',
  async up(session) {
    // 1. Passi orfani: nessuna definizione, quindi nessun tenant da ereditare.
    const orphans = await session.run(`
      MATCH (s:WorkflowStep)
      WHERE NOT (s)<-[:HAS_STEP]-(:WorkflowDefinition) AND s.tenant_id IS NULL
      RETURN s.id AS id, s.name AS name, s.definition_id AS definitionId
      ORDER BY s.name
    `)
    if (orphans.records.length > 0) {
      const list = orphans.records
        .map((r) => `${String(r.get('name'))} (id ${String(r.get('id'))}, definition_id ${String(r.get('definitionId'))})`)
        .join(', ')
      throw new Error(
        `[${workflowStepTenantBackfill.id}] ${orphans.records.length} WorkflowStep senza tenant_id non sono appesi a nessuna WorkflowDefinition: ${list}. ` +
        'Non si può dedurre il tenant: collegali alla definizione giusta o eliminali, poi rilancia.',
      )
    }

    // 2. Chi è incompleto, PRIMA di scrivere.
    const todo = await session.run(`
      MATCH (wd:WorkflowDefinition)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE s.tenant_id IS NULL OR s.is_initial IS NULL OR s.is_terminal IS NULL
         OR s.is_open IS NULL OR s.category IS NULL OR s.step_order IS NULL
      RETURN s.id AS stepId, s.name AS stepName, s.type AS stepType,
             s.step_order IS NULL AS noOrder, s.tenant_id IS NULL AS noTenant,
             wd.id AS defId, wd.name AS defName, wd.tenant_id AS tenantId
      ORDER BY tenantId, defName, stepName
    `)

    if (todo.records.length === 0) {
      console.log(`[${workflowStepTenantBackfill.id}] 0 WorkflowStep da completare — niente da fare`)
      return
    }

    // `step_order` in coda: il massimo di ogni definizione, letto una volta
    // sola e incrementato via via (due passi nuovi non prendono lo stesso posto).
    const nextOrder = new Map<string, number>()
    let noTenantCount = 0

    for (const record of todo.records) {
      const stepId   = String(record.get('stepId'))
      const stepName = String(record.get('stepName'))
      const defId    = String(record.get('defId'))
      const defName  = String(record.get('defName'))
      const tenantId = String(record.get('tenantId'))
      if (record.get('noTenant') === true) noTenantCount++

      let order: number | null = null
      if (record.get('noOrder') === true) {
        if (!nextOrder.has(defId)) {
          const max = await session.run(`
            MATCH (wd:WorkflowDefinition {id: $defId})-[:HAS_STEP]->(s:WorkflowStep)
            RETURN coalesce(max(s.step_order), 0) AS maxOrder
          `, { defId })
          nextOrder.set(defId, Number(max.records[0]?.get('maxOrder') ?? 0) + 1)
        }
        order = nextOrder.get(defId)!
        nextOrder.set(defId, order + 1)
      }

      await session.run(`
        MATCH (s:WorkflowStep {id: $stepId})
        WITH s, coalesce(s.is_terminal, s.type = 'end') AS terminal
        SET s.tenant_id   = coalesce(s.tenant_id, $tenantId),
            s.is_initial  = coalesce(s.is_initial, s.type = 'start'),
            s.is_terminal = terminal,
            s.is_open     = coalesce(s.is_open, NOT terminal),
            s.category    = coalesce(s.category, CASE WHEN terminal THEN 'closed' ELSE 'active' END),
            s.step_order  = coalesce(s.step_order, $order)
      `, { stepId, tenantId, order })

      console.log(
        `[${workflowStepTenantBackfill.id}]   ${tenantId}/${defName}/${stepName} completato` +
        (record.get('noTenant') === true ? ' (mancava tenant_id)' : '') +
        (order != null ? ` (step_order ${order})` : ''),
      )
    }

    console.log(
      `[${workflowStepTenantBackfill.id}] ${todo.records.length} WorkflowStep completati, ` +
      `di cui ${noTenantCount} erano senza tenant_id`,
    )
  },
}
