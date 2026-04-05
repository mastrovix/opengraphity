import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { publish } from '@opengraphity/events'
import { sseManager } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import * as incidentService from '../../services/incidentService.js'
import { workflowLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'

// Safe label map — prevents Cypher injection when creating entities dynamically
const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident',
  problem:  'Problem',
  change:   'Change',
}

// ── Publish workflow.step.entered for notify_rule enter_actions ───────────────

async function publishNotifyRuleActions(
  session: import('neo4j-driver').Session,
  instanceId: string,
  stepName: string,
  tenantId: string,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (wi:WorkflowInstance {id: $instanceId})
       MATCH (wd:WorkflowDefinition {id: wi.definition_id})
       MATCH (s:WorkflowStep {definition_id: wd.id, name: $stepName})
       RETURN s.enter_actions AS enterActions`,
      { instanceId, stepName },
    ),
  )
  if (!result.records.length) return
  const raw = result.records[0].get('enterActions') as string | null
  if (!raw) return

  let actions: Array<{ type: string; params?: Record<string, unknown> }>
  try { actions = JSON.parse(raw) } catch { return }

  const notifyRules = actions.filter((a) => a.type === 'notify_rule')
  for (const action of notifyRules) {
    await publish({
      id:             uuidv4(),
      type:           'workflow.step.entered',
      tenant_id:      tenantId,
      timestamp:      new Date().toISOString(),
      correlation_id: uuidv4(),
      actor_id:       userId,
      payload: {
        stepName,
        entityType,
        entityId,
        notifyRule: action.params ?? {},
      },
    })
  }
}

// ── Mutation resolvers ────────────────────────────────────────────────────────

export async function updateWorkflowStep(
  _: unknown,
  { definitionId, stepName, label, enterActions, exitActions }: { definitionId: string; stepName: string; label: string; enterActions?: string | null; exitActions?: string | null },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const now = new Date().toISOString()
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (s:WorkflowStep {definition_id: $definitionId, name: $stepName, tenant_id: $tenantId})
        SET s.label        = $label,
            s.updated_at   = $now,
            s.enter_actions = CASE WHEN $enterActions IS NOT NULL THEN $enterActions ELSE s.enter_actions END,
            s.exit_actions  = CASE WHEN $exitActions  IS NOT NULL THEN $exitActions  ELSE s.exit_actions  END
        RETURN s
      `, { definitionId, stepName, tenantId: ctx.tenantId, label, enterActions: enterActions ?? null, exitActions: exitActions ?? null, now }),
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

export async function updateWorkflowTransition(
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

export async function executeWorkflowTransition(
  _: unknown,
  { instanceId, toStep, notes }: { instanceId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Pre-fetch entity data for template/condition evaluation in actions
    const entityDataResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wi:WorkflowInstance {id: $instanceId})
        MATCH (entity {id: wi.entity_id, tenant_id: wi.tenant_id})
        RETURN properties(entity) AS entityData
      `, { instanceId }),
    )
    const entityData: Record<string, unknown> =
      entityDataResult.records.length > 0
        ? (entityDataResult.records[0].get('entityData') as Record<string, unknown>)
        : {}

    const actionCtx: ActionContext = {
      userId:     ctx.userId,
      notes,
      entityData,

      createEntity: async (type, data) => {
        const label = ENTITY_LABELS[type]
        if (!label) throw new Error(`Unknown entity type: ${type}`)

        // Extract relation metadata — must not be stored as node properties
        const { parent_id, parent_type, ...nodeData } = data as Record<string, unknown>

        const id = uuidv4()
        const now = new Date().toISOString()
        await session.executeWrite((tx) =>
          tx.run(
            `CREATE (e:${label} $props) RETURN e.id AS id`,
            { props: { id, status: 'new', created_at: now, updated_at: now, ...nodeData } },
          ),
        )

        // Create relation to parent entity when link_to_current was set
        if (parent_id && parent_type) {
          const parentLabel = ENTITY_LABELS[parent_type as string]
          if (parentLabel) {
            // Convention: (problem)-[:CAUSED_BY]->(incident)
            //             (child)-[:RELATED_TO]->(parent) for other combos
            const relType =
              type === 'problem' && parent_type === 'incident' ? 'CAUSED_BY' : 'RELATED_TO'
            const [childLabel, parentLabelFinal] =
              relType === 'CAUSED_BY' ? [label, parentLabel] : [label, parentLabel]
            await session.executeWrite((tx) =>
              tx.run(
                `MATCH (child:${childLabel} {id: $childId})
                 MATCH (parent:${parentLabelFinal} {id: $parentId})
                 MERGE (child)-[:${relType}]->(parent)`,
                { childId: id, parentId: parent_id },
              ),
            )
          }
        }

        return id
      },

      assignTo: async (entityId, targetType, targetId) => {
        const relType = targetType === 'team' ? 'ASSIGNED_TO_TEAM' : 'ASSIGNED_TO'
        const targetLabel = targetType === 'team' ? 'Team' : 'User'
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (e {id: $entityId, tenant_id: $tenantId})
             MATCH (t:${targetLabel} {id: $targetId})
             MERGE (e)-[:${relType}]->(t)`,
            { entityId, tenantId: ctx.tenantId, targetId },
          ),
        )
      },

      updateField: async (entityId, field, value) => {
        const now = new Date().toISOString()
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (e {id: $entityId, tenant_id: $tenantId})
             SET e[$field] = $value, e.updated_at = $now`,
            { entityId, tenantId: ctx.tenantId, field, value, now },
          ),
        )
      },

      publishEvent: async (type, payload) => {
        await publish({
          id:             uuidv4(),
          type,
          tenant_id:      ctx.tenantId,
          timestamp:      new Date().toISOString(),
          correlation_id: uuidv4(),
          actor_id:       ctx.userId,
          payload,
        })
      },

      createApprovalRequest: async ({ entityId, entityType, title, approverRole, approvalType }) => {
        const now = new Date().toISOString()

        // Find approvers by role
        const adminsRes = await session.executeRead((tx) =>
          tx.run(
            `MATCH (u:User {tenant_id: $tenantId, role: $role}) RETURN u.id AS id`,
            { tenantId: ctx.tenantId, role: approverRole ?? 'admin' },
          ),
        )
        const approverIds = adminsRes.records.map((r) => r.get('id') as string)
        const finalApprovers = approverIds.length > 0 ? approverIds : [ctx.userId]

        const approvalId = uuidv4()
        await session.executeWrite((tx) =>
          tx.run(`
            CREATE (ap:ApprovalRequest {
              id:              $id,
              tenant_id:       $tenantId,
              entity_type:     $entityType,
              entity_id:       $entityId,
              title:           $title,
              description:     null,
              status:          'pending',
              requested_by:    $requestedBy,
              requested_at:    $now,
              approvers:       $approvers,
              approved_by:     '[]',
              rejected_by:     null,
              approval_type:   $approvalType,
              due_date:        null,
              resolved_at:     null,
              resolution_note: null
            })
          `, {
            id:           approvalId,
            tenantId:     ctx.tenantId,
            entityType,
            entityId,
            title,
            requestedBy:  ctx.userId,
            now,
            approvers:    JSON.stringify(finalApprovers),
            approvalType: approvalType ?? 'any',
          }),
        )

        // Notify each approver via SSE
        for (const approverId of finalApprovers) {
          sseManager.sendToUser(ctx.tenantId, approverId, {
            id:          uuidv4(),
            type:        'approval.requested',
            title:       'Approvazione richiesta',
            message:     title,
            severity:    'info',
            entity_id:   approvalId,
            entity_type: 'ApprovalRequest',
            timestamp:   now,
            read:        false,
          })
        }

        return approvalId
      },
    }

    workflowLogger.debug({ toStep, instanceId }, 'Transitioning workflow step')
    const result = await workflowEngine.transition(
      session,
      {
        instanceId,
        toStepName:  toStep,
        triggeredBy: ctx.userId,
        triggerType: 'manual',
        notes,
      },
      actionCtx,
    )
    workflowLogger.debug({ instanceId, success: result.success }, 'Workflow transition result')

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
          void audit(ctx, 'incident.resolved',    'Incident', incidentId)
        } else if (toStep === 'escalated') {
          await incidentService.escalateIncident(incidentId, { tenantId, userId: ctx.userId })
          void audit(ctx, 'incident.escalated',   'Incident', incidentId)
        } else if (toStep === 'closed') {
          await incidentService.closeIncident(incidentId, { tenantId, userId: ctx.userId })
          void audit(ctx, 'incident.closed',      'Incident', incidentId)
        } else if (toStep === 'in_progress') {
          await incidentService.inProgressIncident(incidentId, { tenantId, userId: ctx.userId })
          void audit(ctx, 'incident.in_progress', 'Incident', incidentId)
        } else if (toStep === 'pending') {
          await incidentService.onHoldIncident(incidentId, { tenantId, userId: ctx.userId })
          void audit(ctx, 'incident.on_hold',     'Incident', incidentId)
        }

        // Publish workflow.step.entered for any notify_rule enter_actions on this step
        await publishNotifyRuleActions(session, instanceId, toStep, tenantId, ctx.userId, 'incident', incidentId)
      }

      // ── KB Article post-transition ────────────────────────────────────────
      const kbResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId})
          WHERE wi.entity_type = 'kb_article'
          MATCH (a:KBArticle {id: wi.entity_id, tenant_id: wi.tenant_id})
          RETURN a.id AS id, wi.tenant_id AS tenantId, a.requested_by AS requestedBy
        `, { instanceId }),
      )
      if (kbResult.records.length > 0) {
        const kbId     = kbResult.records[0].get('id')     as string
        const tenantId = kbResult.records[0].get('tenantId') as string
        if (toStep === 'published') {
          const pubNow = new Date().toISOString()
          await session.executeWrite((tx) =>
            tx.run(`
              MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})
              SET a.published_at = $now, a.updated_at = $now
            `, { id: kbId, tenantId, now: pubNow }),
          )
          void audit(ctx, 'kb_article.published', 'KBArticle', kbId)
        }
        await publishNotifyRuleActions(session, instanceId, toStep, tenantId, ctx.userId, 'kb_article', kbId)
      }
    }

    return {
      success:  result.success,
      error:    result.error ?? null,
      instance: result.instance ?? null,
    }
  }, true)
}

export async function saveWorkflowChanges(
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

    void audit(ctx, 'workflow.updated', 'WorkflowDefinition', definitionId)

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
