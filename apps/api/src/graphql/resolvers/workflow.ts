import { randomUUID } from 'crypto'
import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import {
  incidentWorkflow,
  incidentAvailableTransitions,
  incidentWorkflowHistory,
  workflowDefinition,
  workflowDefinitionById,
  workflowDefinitions,
  incidentWorkflowInstance,
  incidentAvailableTransitionsField,
  incidentWorkflowHistoryField,
  changeWorkflowInstance,
  changeAvailableTransitionsField,
  changeWorkflowHistoryField,
} from './workflowQueries.js'
import {
  updateWorkflowStep,
  updateWorkflowTransition,
  executeWorkflowTransition,
  saveWorkflowChanges,
} from './workflowMutations.js'

export * from './workflowQueries.js'
export * from './workflowMutations.js'

// ── saveWorkflowLayout (kept here as it's a thin wrapper) ────────────────────

async function saveWorkflowLayout(
  _: unknown,
  { definitionId, positions }: {
    definitionId: string
    positions: Array<{ stepId: string; positionX: number; positionY: number }>
  },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) =>
      tx.run(`
        UNWIND $positions AS pos
        MATCH (s:WorkflowStep {id: pos.stepId})<-[:HAS_STEP]-(wd:WorkflowDefinition {
          id: $definitionId, tenant_id: $tenantId
        })
        SET s.position_x = pos.positionX,
            s.position_y = pos.positionY
      `, { definitionId, tenantId: ctx.tenantId, positions }),
    )
    return true
  }, true)
}

// ── addWorkflowStep ───────────────────────────────────────────────────────────

async function addWorkflowStep(
  _: unknown,
  { definitionId, name, label, type, timerDelayMinutes, subWorkflowId }: {
    definitionId: string; name: string; label: string; type: string
    timerDelayMinutes?: number; subWorkflowId?: string
  },
  ctx: GraphQLContext,
) {
  const ALLOWED_TYPES = new Set(['standard', 'parallel_fork', 'parallel_join', 'timer_wait', 'sub_workflow'])
  if (!ALLOWED_TYPES.has(type)) throw new Error(`Invalid step type: ${type}`)

  return withSession(async (session) => {
    const stepId = randomUUID()
    await session.executeWrite(tx =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        CREATE (s:WorkflowStep {
          id:                  $stepId,
          definition_id:       $definitionId,
          name:                $name,
          label:               $label,
          type:                $type,
          timer_delay_minutes: $timerDelayMinutes,
          sub_workflow_id:     $subWorkflowId,
          enter_actions:       '[]',
          exit_actions:        '[]'
        })
        CREATE (wd)-[:HAS_STEP]->(s)
        SET wd.version = wd.version + 1, wd.updated_at = $now
      `, {
        definitionId, tenantId: ctx.tenantId, stepId,
        name, label, type,
        timerDelayMinutes: timerDelayMinutes ?? null,
        subWorkflowId: subWorkflowId ?? null,
        now: new Date().toISOString(),
      }),
    )
    return workflowDefinitionById(_, { id: definitionId }, ctx)
  }, true)
}

// ── removeWorkflowStep ────────────────────────────────────────────────────────

async function removeWorkflowStep(
  _: unknown,
  { definitionId, stepName }: { definitionId: string; stepName: string },
  ctx: GraphQLContext,
) {
  const PROTECTED = new Set(['start', 'end'])
  return withSession(async (session) => {
    const res = await session.executeRead(tx =>
      tx.run(`MATCH (s:WorkflowStep {definition_id: $definitionId, name: $stepName}) RETURN s.type AS type`, { definitionId, stepName }),
    )
    const stepType = res.records[0]?.get('type') as string | null
    if (!stepType || PROTECTED.has(stepType)) throw new Error(`Cannot remove step: ${stepName}`)

    await session.executeWrite(tx =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        MATCH (s:WorkflowStep {definition_id: $definitionId, name: $stepName})
        DETACH DELETE s
        SET wd.version = wd.version + 1, wd.updated_at = $now
      `, { definitionId, tenantId: ctx.tenantId, stepName, now: new Date().toISOString() }),
    )
    return workflowDefinitionById(_, { id: definitionId }, ctx)
  }, true)
}

// ── Combined resolver object ──────────────────────────────────────────────────

export const workflowResolvers = {
  Query: {
    incidentWorkflow,
    incidentAvailableTransitions,
    incidentWorkflowHistory,
    workflowDefinition,
    workflowDefinitionById,
    workflowDefinitions,
  },
  Mutation: {
    addWorkflowStep,
    removeWorkflowStep,
    updateWorkflowStep,
    updateWorkflowTransition,
    executeWorkflowTransition,
    saveWorkflowLayout,
    saveWorkflowChanges,
  },
  Incident: {
    workflowInstance:     incidentWorkflowInstance,
    availableTransitions: incidentAvailableTransitionsField,
    workflowHistory:      incidentWorkflowHistoryField,
  },
  Change: {
    workflowInstance:     changeWorkflowInstance,
    availableTransitions: changeAvailableTransitionsField,
    workflowHistory:      changeWorkflowHistoryField,
  },
}
