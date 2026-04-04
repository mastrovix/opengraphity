import { workflowEngine } from '@opengraphity/workflow'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'

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

    const trResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $defId})
        MATCH (from:WorkflowStep {definition_id: $defId})-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
        RETURN from.name AS fromStep, to.name AS toStep,
               tr.id AS id, tr.trigger AS trigger, tr.label AS label,
               tr.requires_input AS requiresInput,
               tr.input_field AS inputField,
               tr.condition AS condition,
               tr.timer_hours AS timerHours
      `, { defId: wd['id'] }),
    )

    return {
      id:         wd['id']          as string,
      name:       wd['name']        as string,
      entityType: wd['entity_type'] as string,
      version:    wd['version']     as number,
      active:     wd['active']      as boolean,
      steps: steps.map((s) => ({
        id:           s.properties['id']            as string,
        name:         s.properties['name']          as string,
        label:        s.properties['label']         as string,
        type:         s.properties['type']          as string,
        enterActions:       (s.properties['enter_actions']       ?? null) as string | null,
        exitActions:        (s.properties['exit_actions']        ?? null) as string | null,
        timerDelayMinutes:  (s.properties['timer_delay_minutes'] ?? null) as number | null,
        subWorkflowId:      (s.properties['sub_workflow_id']     ?? null) as string | null,
      })),
      transitions: trResult.records.map((r) => ({
        id:            r.get('id')            as string,
        fromStepName:  r.get('fromStep')      as string,
        toStepName:    r.get('toStep')        as string,
        trigger:       r.get('trigger')       as string,
        label:         r.get('label')         as string,
        requiresInput: r.get('requiresInput') as boolean,
        inputField:    (r.get('inputField')   ?? null) as string | null,
        condition:     (r.get('condition')    ?? null) as string | null,
        timerHours:    (r.get('timerHours')   ?? null) as number | null,
      })),
    }
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

    const trResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (from:WorkflowStep {definition_id: $defId})-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
        RETURN from.name AS fromStep, to.name AS toStep,
               tr.id AS id, tr.trigger AS trigger, tr.label AS label,
               tr.requires_input AS requiresInput,
               tr.input_field AS inputField,
               tr.condition AS condition,
               tr.timer_hours AS timerHours
      `, { defId: id }),
    )

    return {
      id:         wd['id']          as string,
      name:       wd['name']        as string,
      entityType: wd['entity_type'] as string,
      version:    wd['version']     as number,
      active:     wd['active']      as boolean,
      steps: steps.map((s) => ({
        id:           s.properties['id']             as string,
        name:         s.properties['name']           as string,
        label:        s.properties['label']          as string,
        type:         s.properties['type']           as string,
        enterActions:       (s.properties['enter_actions']       ?? null) as string | null,
        exitActions:        (s.properties['exit_actions']        ?? null) as string | null,
        timerDelayMinutes:  (s.properties['timer_delay_minutes'] ?? null) as number | null,
        subWorkflowId:      (s.properties['sub_workflow_id']     ?? null) as string | null,
      })),
      transitions: trResult.records.map((r) => ({
        id:            r.get('id')            as string,
        fromStepName:  r.get('fromStep')      as string,
        toStepName:    r.get('toStep')        as string,
        trigger:       r.get('trigger')       as string,
        label:         r.get('label')         as string,
        requiresInput: r.get('requiresInput') as boolean,
        inputField:    (r.get('inputField')   ?? null) as string | null,
        condition:     (r.get('condition')    ?? null) as string | null,
        timerHours:    (r.get('timerHours')   ?? null) as number | null,
      })),
    }
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
    if (!defResult.records.length) return []

    const results = []
    for (const record of defResult.records) {
      const wd    = record.get('wd').properties    as Record<string, unknown>
      const steps = record.get('steps') as Array<{ properties: Record<string, unknown> }>

      const trResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wd:WorkflowDefinition {id: $defId})
          MATCH (from:WorkflowStep {definition_id: $defId})-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
          RETURN from.name AS fromStep, to.name AS toStep,
                 tr.id AS id, tr.trigger AS trigger, tr.label AS label,
                 tr.requires_input AS requiresInput,
                 tr.input_field AS inputField,
                 tr.condition AS condition,
                 tr.timer_hours AS timerHours
        `, { defId: wd['id'] }),
      )

      results.push({
        id:         wd['id']          as string,
        name:       wd['name']        as string,
        entityType: wd['entity_type'] as string,
        version:    wd['version']     as number,
        active:     wd['active']      as boolean,
        steps: steps.map((s) => ({
          id:           s.properties['id']             as string,
          name:         s.properties['name']           as string,
          label:        s.properties['label']          as string,
          type:         s.properties['type']           as string,
          enterActions: (s.properties['enter_actions'] ?? null) as string | null,
          exitActions:  (s.properties['exit_actions']  ?? null) as string | null,
        })),
        transitions: trResult.records.map((r) => ({
          id:            r.get('id')            as string,
          fromStepName:  r.get('fromStep')      as string,
          toStepName:    r.get('toStep')        as string,
          trigger:       r.get('trigger')       as string,
          label:         r.get('label')         as string,
          requiresInput: r.get('requiresInput') as boolean,
          inputField:    (r.get('inputField')   ?? null) as string | null,
          condition:     (r.get('condition')    ?? null) as string | null,
          timerHours:    (r.get('timerHours')   ?? null) as number | null,
        })),
      })
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
