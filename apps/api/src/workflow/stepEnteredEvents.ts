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
  })
}

registerStepEnteredEvents()
