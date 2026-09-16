/**
 * Ogni ingresso in un passo del motore di workflow diventa l'evento
 * `workflow.step_entered` (vedi `WORKFLOW_STEP_ENTERED_EVENT`).
 *
 * Registrato all'import, come le condizioni (`conditions.ts` lo importa): ogni
 * processo che esegue transizioni lo ha. Senza, gli eventi di dominio li
 * pubblicavano solo alcuni cammini, e lo SLA di un problem risolto dalla sua
 * change o di una richiesta chiusa dal workflow restava aperto per sempre.
 */
import { workflowEngine } from '@opengraphity/workflow'
import { WORKFLOW_STEP_ENTERED_EVENT, type WorkflowStepEnteredPayload } from '@opengraphity/types'
import { publishEvent } from '../lib/publishEvent.js'
import { publishStepEnteredForEntity } from '../lib/stepEnteredPublisher.js'

let registered = false

export function registerStepEnteredEvents(): void {
  if (registered) return
  registered = true
  workflowEngine.onStepEntered(async (info) => {
    const payload: WorkflowStepEnteredPayload = {
      entity_type:   info.entityType,
      entity_id:     info.entityId,
      from_step:     info.fromStep,
      from_initial:  info.fromInitial,
      step_name:     info.toStep,
      step_category: info.category,
      step_terminal: info.terminal,
      entered_at:    info.enteredAt,
      trigger_type:  info.triggerType,
    }
    await publishEvent(WORKFLOW_STEP_ENTERED_EVENT, info.tenantId, info.actorId, payload, info.enteredAt)

    // L'evento di DOMINIO dell'entità (`incident.step_entered` + l'alias
    // `incident.<passo>`): da qui passano TUTTI i cammini, compresi quelli
    // automatici, che prima muovevano il ticket senza far scattare nessuna
    // regola di notifica né nessun webhook (revisione totale · C-1).
    await publishStepEnteredForEntity({
      tenantId:   info.tenantId,
      actorId:    info.actorId,
      entityType: info.entityType,
      entityId:   info.entityId,
      stepName:   info.toStep,
      enteredAt:  info.enteredAt,
      // B-4: le note della transizione finiscono nella nota interna sul ticket.
      notes:      info.notes ?? null,
      fromStep:   info.fromStep,
    })

    // `incident.closed` (la regola di notifica «Incident chiuso») lo pubblicava
    // solo il job `auto_close`, cioè solo la chiusura automatica di fabbrica.
    // Ora si chiude con una scadenza qualunque o con un arco del cliente: lo
    // dice l'ingresso nel passo di categoria «closed», da qualunque cammino
    // (verifica «Cosa resta cablato», ondata 3).
    if (info.entityType === 'incident' && info.category === 'closed') {
      const { closeIncident } = await import('../services/incidentService.js')
      await closeIncident(info.entityId, { tenantId: info.tenantId, userId: info.actorId })
    }
  })
}

registerStepEnteredEvents()
