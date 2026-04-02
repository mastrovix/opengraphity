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
}
