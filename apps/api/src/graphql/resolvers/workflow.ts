import { workflowEngine } from '@opengraphity/workflow'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import * as incidentService from '../../services/incidentService.js'

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
    durationMs:  e['duration_ms'] == null ? null : (typeof e['duration_ms'] === 'object' ? (e['duration_ms'] as { toNumber(): number }).toNumber() : Math.round(Number(e['duration_ms']))),
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
    }
  })
}

async function workflowDefinitionById(
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
  { definitionId, transitionId, input }: {
    definitionId: string
    transitionId: string
    input: {
      label?: string | null
      trigger?: string | null
      requiresInput: boolean
      inputField?: string | null
      condition?: string | null
      timerHours?: number | null
    }
  },
  ctx: GraphQLContext,
) {
  const { label, trigger, requiresInput, inputField, condition, timerHours } = input
  return withSession(async (session) => {
    await session.executeWrite((tx) =>
      tx.run(`
        MATCH ()-[t:TRANSITIONS_TO {id: $transitionId}]->()
        SET t.label          = coalesce($label, t.label),
            t.trigger        = coalesce($trigger, t.trigger),
            t.requires_input = $requiresInput,
            t.input_field    = coalesce($inputField, t.input_field),
            t.condition      = coalesce($condition, t.condition),
            t.timer_hours    = coalesce($timerHours, t.timer_hours)
      `, {
        transitionId,
        label:         label         ?? null,
        trigger:       trigger       ?? null,
        requiresInput,
        inputField:    inputField    ?? null,
        condition:     condition     ?? null,
        timerHours:    timerHours    ?? null,
      }),
    )
    const wdResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
        RETURN wd, collect(s) AS steps
        LIMIT 1
      `, { definitionId, tenantId: ctx.tenantId }),
    )
    if (!wdResult.records.length) throw new Error('WorkflowDefinition non trovata')
    const wd    = wdResult.records[0].get('wd').properties    as Record<string, unknown>
    const steps = wdResult.records[0].get('steps') as Array<{ properties: Record<string, unknown> }>
    const trResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (from:WorkflowStep {definition_id: $defId})-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
        RETURN from.name AS fromStep, to.name AS toStep,
               tr.id AS id, tr.trigger AS trigger, tr.label AS label,
               tr.requires_input AS requiresInput,
               tr.input_field AS inputField,
               tr.condition AS condition,
               tr.timer_hours AS timerHours
      `, { defId: definitionId }),
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

    if (result.success) {
      const wiResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId})
          WHERE wi.entity_type = 'incident'
          MATCH (i:Incident {id: wi.entity_id, tenant_id: wi.tenant_id})
          OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci:ConfigurationItem)
          OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
          OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
          RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status,
                 wi.tenant_id AS tenantId,
                 collect(DISTINCT ci.name)[0] AS ciName,
                 u.name AS assignedTo, t.name AS teamName
        `, { instanceId }),
      )
      if (wiResult.records.length > 0) {
        const r        = wiResult.records[0]
        const tenantId = r.get('tenantId') as string
        const incidentId = r.get('id') as string

        // Add automatic comment for every incident workflow transition
        const commentText = notes ? `Workflow: ${toStep} — ${notes}` : `Workflow: ${toStep}`
        const now = new Date().toISOString()
        await session.executeWrite((tx) => tx.run(`
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
          CREATE (c:Comment {
            id:         randomUUID(),
            tenant_id:  $tenantId,
            text:       $text,
            author_id:  $userId,
            created_at: $now,
            updated_at: $now
          })
          CREATE (i)-[:HAS_COMMENT]->(c)
        `, { incidentId, tenantId, text: commentText, userId: ctx.userId, now }))

        if (toStep === 'resolved') {
          await incidentService.resolveIncident(incidentId, { tenantId, userId: ctx.userId })
        } else if (toStep === 'escalated') {
          await incidentService.escalateIncident(incidentId, { tenantId, userId: ctx.userId })
        } else if (toStep === 'closed') {
          await incidentService.closeIncident(incidentId, { tenantId, userId: ctx.userId })
        }
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

async function saveWorkflowChanges(
  _: unknown,
  { definitionId, transitions, positions }: {
    definitionId: string
    transitions: Array<{
      transitionId:  string
      label?:        string | null
      trigger?:      string | null
      requiresInput: boolean
      inputField?:   string | null
      condition?:    string | null
      timerHours?:   number | null
    }>
    positions: Array<{ stepId: string; positionX: number; positionY: number }>
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    // Update each transition
    if (transitions.length > 0) {
      await session.executeWrite((tx) =>
        tx.run(`
          UNWIND $transitions AS tr
          MATCH ()-[t:TRANSITIONS_TO {id: tr.transitionId}]->()
          SET t.label          = coalesce(tr.label, t.label),
              t.trigger        = coalesce(tr.trigger, t.trigger),
              t.requires_input = tr.requiresInput,
              t.input_field    = tr.inputField,
              t.condition      = tr.condition,
              t.timer_hours    = tr.timerHours
        `, { transitions }),
      )
    }
    // Update step positions
    if (positions.length > 0) {
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
    }
    // Increment version and return full definition
    const wdResult = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        SET wd.version    = wd.version + 1,
            wd.updated_at = $now
        RETURN wd
      `, { definitionId, tenantId: ctx.tenantId, now }),
    )
    if (!wdResult.records.length) throw new Error('WorkflowDefinition non trovata')
    const wd = wdResult.records[0].get('wd').properties as Record<string, unknown>

    const stepsResult = await session.executeRead((tx) =>
      tx.run(`MATCH (wd:WorkflowDefinition {id: $definitionId})-[:HAS_STEP]->(s:WorkflowStep) RETURN collect(s) AS steps`,
        { definitionId }),
    )
    const steps = stepsResult.records[0]?.get('steps') as Array<{ properties: Record<string, unknown> }> ?? []

    const trResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (from:WorkflowStep {definition_id: $defId})-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
        RETURN from.name AS fromStep, to.name AS toStep,
               tr.id AS id, tr.trigger AS trigger, tr.label AS label,
               tr.requires_input AS requiresInput,
               tr.input_field AS inputField,
               tr.condition AS condition,
               tr.timer_hours AS timerHours
      `, { defId: definitionId }),
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
    }
  }, true)
}

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
