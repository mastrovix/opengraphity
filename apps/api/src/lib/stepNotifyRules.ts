/**
 * The «notify on enter» of a workflow step (`notify_rule` enter actions)
 * becomes a `workflow.step.entered` event, for the notifications dispatcher.
 *
 * Review of 23 Sep 2026: the engine leaves `notify_rule` to the API, and the
 * API published it only from the MANUAL transition of an incident or a KB
 * article. The designer offers it on every step of every workflow, so on a
 * request, a problem or a change, or when a deadline, a timer or a rule moved
 * the ticket, it did nothing and said nothing. It is now published from the
 * engine's `onStepEntered` hook (workflow/stepEnteredEvents.ts), which every
 * path and every ticket type goes through.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'

export interface StepNotifyInfo {
  tenantId:   string
  instanceId: string
  stepName:   string
  actorId:    string
  entityType: string
  entityId:   string
}

/** Publishes one `workflow.step.entered` event per notify_rule of the step entered. */
export async function publishStepNotifyRules(info: StepNotifyInfo): Promise<number> {
  const session = getSession(undefined, 'READ')
  let row: { enterActions: string | null; stepLabel: string | null } | null
  try {
    row = await runQueryOne(session, `
      MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
      // tenant-ok(traversal): definizione e step seguono l'istanza appena scopata
      MATCH (wd:WorkflowDefinition {id: wi.definition_id})
      // tenant-ok(traversal): idem
      MATCH (s:WorkflowStep {definition_id: wd.id, name: $stepName})
      RETURN s.enter_actions AS enterActions, s.label AS stepLabel`,
      { instanceId: info.instanceId, stepName: info.stepName, tenantId: info.tenantId })
  } finally {
    await session.close()
  }
  if (!row?.enterActions) return 0

  let actions: Array<{ type: string; params?: Record<string, unknown> }>
  try { actions = JSON.parse(row.enterActions) }
  catch (e) {
    // Corrupt enter_actions do not drop the step's notifications in silence.
    throw new Error(`Corrupt enter_actions JSON on step "${info.stepName}": ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  // The label of the step travels in the event: the fallback title when the
  // rule's i18n key is not translated (B-16).
  const stepLabel = row.stepLabel ?? info.stepName
  const notifyRules = actions.filter((a) => a.type === 'notify_rule')
  for (const action of notifyRules) {
    await publish({
      id:             uuidv4(),
      type:           'workflow.step.entered',
      tenant_id:      info.tenantId,
      timestamp:      new Date().toISOString(),
      correlation_id: uuidv4(),
      actor_id:       info.actorId,
      payload: {
        stepName:   info.stepName,
        stepLabel,
        entityType: info.entityType,
        entityId:   info.entityId,
        notifyRule: action.params ?? {},
      },
    })
  }
  return notifyRules.length
}
