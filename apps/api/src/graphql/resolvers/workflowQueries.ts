import { GraphQLError } from 'graphql'
import { workflowEngine } from '@opengraphity/workflow'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { loadTransitionRows, mapWorkflowDefinition } from './workflowMapping.js'

// ── WorkflowStep.currentInstances ─────────────────────────────────────────────

/**
 * Conteggi per definizione, vivi solo per il giro corrente dell'event loop:
 * i field resolver degli N step di una definizione partono tutti nello stesso
 * tick, quindi la prima chiamata fa l'unica query e le altre aspettano la sua
 * promessa (niente N+1). `setImmediate` la butta via subito dopo: questo NON è
 * una cache di dati, un `refetch` dopo un'eliminazione deve rileggere il grafo.
 */
const stepInstanceCounts = new Map<string, Promise<Record<string, number>>>()

function loadStepInstanceCounts(tenantId: string, definitionId: string): Promise<Record<string, number>> {
  const key = `${tenantId}::${definitionId}`
  const hit = stepInstanceCounts.get(key)
  if (hit) return hit
  const promise = withSession(async (session) => {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
      OPTIONAL MATCH (wi:WorkflowInstance)-[:CURRENT_STEP]->(s)
      RETURN s.name AS name, count(wi) AS n
    `, { definitionId, tenantId }))
    const out: Record<string, number> = {}
    for (const r of res.records) out[r.get('name') as string] = Number(r.get('n') ?? 0)
    return out
  })
  stepInstanceCounts.set(key, promise)
  setImmediate(() => stepInstanceCounts.delete(key))
  return promise
}

/**
 * Quante istanze di workflow stanno ORA su questo step. È il numero che rende
 * l'eliminazione dello step un'operazione distruttiva (B-1): il disegnatore lo
 * usa per spegnere il bottone «Elimina step» e dire perché.
 */
export async function workflowStepCurrentInstances(
  step: { definitionId?: string | null; name: string },
  _: unknown,
  ctx: GraphQLContext,
): Promise<number> {
  if (!step.definitionId) {
    throw new GraphQLError(`Step "${step.name}" senza definition_id: dato incompleto, impossibile contarne le istanze`, { extensions: { code: 'CONFLICT' } })
  }
  const counts = await loadStepInstanceCounts(ctx.tenantId, step.definitionId)
  const n = counts[step.name]
  if (n == null) {
    throw new GraphQLError(
      `Step "${step.name}" non trovato nella definizione ${step.definitionId}: non si può dire quante istanze lo occupano`,
      { extensions: { code: 'CONFLICT' } },
    )
  }
  return n
}

// ── Shared mappers ────────────────────────────────────────────────────────────

export function mapWI(wi: Record<string, unknown>) {
  return {
    id:          wi['id']           as string,
    currentStep: wi['current_step'] as string,
    status:      wi['status']       as string,
    createdAt:   wi['created_at']   as string,
    updatedAt:   wi['updated_at']   as string,
  }
}

export function mapExec(e: Record<string, unknown>) {
  return {
    id:          e['id']           as string,
    stepName:    e['step_name']    as string,
    enteredAt:   e['entered_at']   as string,
    exitedAt:    (e['exited_at']   ?? null) as string | null,
    durationMs:  e['duration_ms'] == null ? null : (typeof e['duration_ms'] === 'object' ? (e['duration_ms'] as { toNumber(): number }).toNumber() : Math.round(Number(e['duration_ms']))),
    triggeredBy: e['triggered_by'] as string,
    triggerType: e['trigger_type'] as string,
    notes:       (e['notes']       ?? null) as string | null,
  }
}

// ── Query resolvers ───────────────────────────────────────────────────────────

export async function incidentWorkflow(
  _: unknown,
  { incidentId }: { incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { incidentId, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function incidentAvailableTransitions(
  _: unknown,
  { incidentId }: { incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { incidentId, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}

export async function incidentWorkflowHistory(
  _: unknown,
  { incidentId }: { incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { incidentId, tenantId: ctx.tenantId }),
    )
    return result.records.map((r) =>
      mapExec(r.get('exec').properties as Record<string, unknown>),
    )
  })
}

export async function workflowDefinition(
  _: unknown,
  { entityType }: { entityType: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const defResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: $entityType, active: true})
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN wd, collect(s) AS steps
        LIMIT 1
      `, { tenantId: ctx.tenantId, entityType }),
    )
    if (!defResult.records.length) return null

    const wd    = defResult.records[0].get('wd').properties    as Record<string, unknown>
    const steps = defResult.records[0].get('steps') as Array<{ properties: Record<string, unknown> }>
    const transitions = await loadTransitionRows(session, wd['id'] as string, ctx.tenantId)
    return mapWorkflowDefinition(wd, steps, transitions)
  })
}

export async function workflowDefinitionById(
  _: unknown,
  { id }: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const defResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $id, tenant_id: $tenantId})
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN wd, collect(s) AS steps
        LIMIT 1
      `, { id, tenantId: ctx.tenantId }),
    )
    if (!defResult.records.length) return null

    const wd    = defResult.records[0].get('wd').properties    as Record<string, unknown>
    const steps = defResult.records[0].get('steps') as Array<{ properties: Record<string, unknown> }>
    const transitions = await loadTransitionRows(session, id, ctx.tenantId)
    return mapWorkflowDefinition(wd, steps, transitions)
  })
}

export async function workflowDefinitions(
  _: unknown,
  { entityType }: { entityType?: string | null },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const defResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, active: true})
        WHERE $entityType IS NULL OR wd.entity_type = $entityType
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN wd, collect(s) AS steps
      `, { tenantId: ctx.tenantId, entityType: entityType ?? null }),
    )

    const results = []
    for (const record of defResult.records) {
      const wd    = record.get('wd').properties    as Record<string, unknown>
      const steps = record.get('steps') as Array<{ properties: Record<string, unknown> }>
      const transitions = await loadTransitionRows(session, wd['id'] as string, ctx.tenantId)
      results.push(mapWorkflowDefinition(wd, steps, transitions))
    }
    return results
  })
}

// ── Field resolvers on Incident ───────────────────────────────────────────────

export async function incidentWorkflowInstance(
  incident: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { id: incident.id, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function incidentAvailableTransitionsField(
  incident: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { id: incident.id, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}

export async function incidentWorkflowHistoryField(
  incident: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { id: incident.id, tenantId: ctx.tenantId }),
    )
    return result.records.map((r) =>
      mapExec(r.get('exec').properties as Record<string, unknown>),
    )
  })
}

// ── Field resolvers on Change ─────────────────────────────────────────────────

export async function changeWorkflowInstance(
  change: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { id: change.id, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function changeAvailableTransitionsField(
  change: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { id: change.id, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}

export async function changeWorkflowHistoryField(
  change: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})
              -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec
        ORDER BY exec.entered_at ASC
      `, { id: change.id, tenantId: ctx.tenantId }),
    )
    return result.records.map((r) =>
      mapExec(r.get('exec').properties as Record<string, unknown>),
    )
  })
}

// ── Field resolvers on ServiceRequest ─────────────────────────────────────────

export async function serviceRequestWorkflowInstance(
  sr: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi
      `, { id: sr.id, tenantId: ctx.tenantId }),
    )
    if (!result.records.length) return null
    return mapWI(result.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function serviceRequestAvailableTransitionsField(
  sr: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { id: sr.id, tenantId: ctx.tenantId }),
    )
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0].get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}
