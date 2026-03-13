import { getSession } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { publish } from '@opengraphity/events'
import { v4 as uuidv4 } from 'uuid'
import type { DomainEvent } from '@opengraphity/types'
import type { IncidentEventPayload } from './incident.js'
import type { GraphQLContext } from '../../context.js'

type Session = ReturnType<typeof getSession>

async function withSession<T>(fn: (s: Session) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

function mapWI(wi: Record<string, unknown>) {
  return {
    id:          wi['id']           as string,
    currentStep: wi['current_step'] as string,
    status:      wi['status']       as string,
    createdAt:   wi['created_at']   as string,
    updatedAt:   wi['updated_at']   as string,
  }
}

function mapExec(e: Record<string, unknown>) {
  return {
    id:          e['id']           as string,
    stepName:    e['step_name']    as string,
    enteredAt:   e['entered_at']   as string,
    exitedAt:    (e['exited_at']   ?? null) as string | null,
    durationMs:  (e['duration_ms'] ?? null) as number | null,
    triggeredBy: e['triggered_by'] as string,
    triggerType: e['trigger_type'] as string,
    notes:       (e['notes']       ?? null) as string | null,
  }
}

// ── Query resolvers ───────────────────────────────────────────────────────────

async function incidentWorkflow(
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

async function incidentAvailableTransitions(
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

async function incidentWorkflowHistory(
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

async function workflowDefinition(
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
               tr.condition AS condition
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
      })),
    }
  })
}

async function workflowDefinitions(
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
                 tr.condition AS condition
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
        })),
      })
    }

    return results
  })
}

// ── Mutation resolvers ────────────────────────────────────────────────────────

async function updateWorkflowStep(
  _: unknown,
  { definitionId, stepName, label }: { definitionId: string; stepName: string; label: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const now = new Date().toISOString()
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (s:WorkflowStep {definition_id: $definitionId, name: $stepName, tenant_id: $tenantId})
        SET s.label = $label, s.updated_at = $now
        RETURN s
      `, { definitionId, stepName, tenantId: ctx.tenantId, label, now }),
    )
    if (!result.records.length) throw new Error('WorkflowStep non trovato')
    const s = result.records[0].get('s').properties as Record<string, unknown>
    return {
      id:           s['id']             as string,
      name:         s['name']           as string,
      label:        s['label']          as string,
      type:         s['type']           as string,
      enterActions: (s['enter_actions'] ?? null) as string | null,
      exitActions:  (s['exit_actions']  ?? null) as string | null,
    }
  }, true)
}

async function updateWorkflowTransition(
  _: unknown,
  { definitionId, transitionId, label, requiresInput, inputField }: {
    definitionId: string; transitionId: string; label: string
    requiresInput: boolean; inputField?: string | null
  },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (from:WorkflowStep {definition_id: $definitionId, tenant_id: $tenantId})
              -[tr:TRANSITIONS_TO {id: $transitionId}]->
              (to:WorkflowStep)
        SET tr.label         = $label,
            tr.requires_input = $requiresInput,
            tr.input_field    = $inputField
        RETURN from.name AS fromStep, to.name AS toStep,
               tr.id AS id, tr.trigger AS trigger, tr.label AS label,
               tr.requires_input AS requiresInput,
               tr.input_field AS inputField,
               tr.condition AS condition
      `, { definitionId, tenantId: ctx.tenantId, transitionId, label, requiresInput, inputField: inputField ?? null }),
    )
    if (!result.records.length) throw new Error('Transizione non trovata')
    const r = result.records[0]
    return {
      id:            r.get('id')            as string,
      fromStepName:  r.get('fromStep')      as string,
      toStepName:    r.get('toStep')        as string,
      trigger:       r.get('trigger')       as string,
      label:         r.get('label')         as string,
      requiresInput: r.get('requiresInput') as boolean,
      inputField:    (r.get('inputField')   ?? null) as string | null,
      condition:     (r.get('condition')    ?? null) as string | null,
    }
  }, true)
}

async function executeWorkflowTransition(
  _: unknown,
  { instanceId, toStep, notes }: { instanceId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await workflowEngine.transition(
      session,
      {
        instanceId,
        toStepName:  toStep,
        triggeredBy: ctx.userId,
        triggerType: 'manual',
        notes,
      },
      { userId: ctx.userId },
    )

    if (result.success && toStep === 'escalated') {
      const wiResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId})
          WHERE wi.entity_type = 'incident'
          MATCH (i:Incident {id: wi.entity_id, tenant_id: wi.tenant_id})
          OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci:ConfigurationItem)
          OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
          RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status,
                 wi.tenant_id AS tenantId,
                 collect(ci.name)[0] AS ciName, u.name AS assignedTo
        `, { instanceId }),
      )
      if (wiResult.records.length > 0) {
        const r = wiResult.records[0]
        const escalatedEvent: DomainEvent<IncidentEventPayload> = {
          id:             uuidv4(),
          type:           'incident.escalated',
          tenant_id:      r.get('tenantId') as string,
          timestamp:      new Date().toISOString(),
          correlation_id: uuidv4(),
          actor_id:       ctx.userId,
          payload: {
            id:         r.get('id')         as string,
            title:      r.get('title')      as string,
            severity:   r.get('severity')   as string,
            status:     'escalated',
            ciName:     (r.get('ciName')    ?? '—') as string,
            assignedTo: (r.get('assignedTo') ?? '—') as string,
          },
        }
        await publish(escalatedEvent)
      }
    }

    return {
      success:  result.success,
      error:    result.error ?? null,
      instance: result.instance ?? null,
    }
  }, true)
}

// ── Field resolvers on Incident ───────────────────────────────────────────────

async function incidentWorkflowInstance(
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

async function incidentAvailableTransitionsField(
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

async function incidentWorkflowHistoryField(
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

// ── Export ────────────────────────────────────────────────────────────────────

export const workflowResolvers = {
  Query: {
    incidentWorkflow,
    incidentAvailableTransitions,
    incidentWorkflowHistory,
    workflowDefinition,
    workflowDefinitions,
  },
  Mutation: {
    updateWorkflowStep,
    updateWorkflowTransition,
    executeWorkflowTransition,
  },
  Incident: {
    workflowInstance:     incidentWorkflowInstance,
    availableTransitions: incidentAvailableTransitionsField,
    workflowHistory:      incidentWorkflowHistoryField,
  },
}
