/**
 * WHO DOES WHAT THE STEP ACTIONS ASK, registered once per process (review of
 * 23 Sep 2026, wave 7 · B1).
 *
 * `assign_to`, `update_field`, `create_entity` and `create_approval_request`
 * write the graph, and until now their writer came as a callback inside the
 * ActionContext — that is, from whoever called the transition. Of the
 * twenty-six calls to the engine only one gave all four (the manual
 * transition); nineteen passed `entityData: {}` and nothing else. On those
 * paths — the escalation, the reopening from the portal, the outcome of an
 * approval, the automatic changes, the resolution of an incident — a step
 * «assign to the Network team» failed, and the ticket moved on anyway with
 * the error in `actionErrors`.
 *
 * Doing these actions is a property of the installation, not of the caller:
 * the same as evaluating a condition (`registerCondition`) or creating a task
 * (`registerTaskCreator`). Registered at start (apps/api/src/workflow), they
 * hold for every path.
 */

/** Who asks for the action: the tenant, the actor of the transition and the step being entered. */
export interface StepActionActor {
  tenantId: string
  userId:   string
  stepName: string
}

/** The entity of the workflow the action runs on. */
export interface StepActionEntity {
  id:   string
  type: string
}

export interface StepApprovalRequestParams {
  title:            string
  approverRole?:    string
  /** People and teams who approve (catalog forms, wave 3): the approvers are the union. */
  approverUserIds?: string[]
  approverTeamIds?: string[]
  approvalType?:    string
}

export interface StepActionHandlers {
  /** Creates an incident, problem or change from the step; returns its id. `data` carries the title and the fields. */
  createEntity(actor: StepActionActor, type: string, data: Record<string, unknown>, parent: StepActionEntity): Promise<string>
  /** Assigns the entity to a team or a person. */
  assignTo(actor: StepActionActor, entity: StepActionEntity, targetType: string, targetId: string): Promise<void>
  /** Writes one field of the entity, checked against the tenant's metamodel. */
  updateField(actor: StepActionActor, entity: StepActionEntity, field: string, value: unknown): Promise<void>
  /** Creates the approval request of the step being entered; returns its id. */
  createApprovalRequest(actor: StepActionActor, entity: StepActionEntity, params: StepApprovalRequestParams): Promise<string>
  /** Publishes a domain event of the tenant. */
  publishEvent(actor: StepActionActor, type: string, payload: Record<string, unknown>): Promise<void>
}

let handlers: StepActionHandlers | null = null

/** Declares who does the step actions. To call at the start of the process, next to the conditions. */
export function registerStepActionHandlers(h: StepActionHandlers): void {
  handlers = h
}

/** The step action handlers of this process, or `null` when nobody declared them. */
export function currentStepActionHandlers(): StepActionHandlers | null {
  return handlers
}

/** For the tests only: forgets the registered handlers. */
export function clearStepActionHandlers(): void {
  handlers = null
}
