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
import { validateRequiredFields } from '../../lib/validateRequiredFields.js'

// Safe label map — prevents Cypher injection when creating entities dynamically
const ENTITY_LABELS: Record<string, string> = {
  incident:   'Incident',
  problem:    'Problem',
  change:     'Change',
  kb_article: 'KBArticle',
}

/**
 * Apply the `on_enter_fields` metadata of the newly-entered step to the
 * underlying entity. Value tokens:
 *   '$now'    → current ISO timestamp
 *   '$userId' → current user id
 *   '$notes'  → transition notes (can be null)
 * Any other string is taken verbatim.
 *
 * The entity label is resolved from the WorkflowInstance.entity_type.
 */
async function applyOnEnterFields(
  session: import('neo4j-driver').Session,
  instanceId: string,
  stepName: string,
  userId: string,
  notes?: string,
): Promise<void> {
  const fieldsRow = await session.executeRead((tx) => tx.run(`
    MATCH (wi:WorkflowInstance {id: $instanceId})-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName
    RETURN step.on_enter_fields AS fields,
           wi.entity_id   AS entityId,
           wi.tenant_id   AS tenantId,
           wi.entity_type AS entityType
  `, { instanceId, stepName }))
  if (!fieldsRow.records.length) return
  const rec       = fieldsRow.records[0]
  const raw       = rec.get('fields')     as string | null
  if (!raw) return
  const entityId   = rec.get('entityId')   as string
  const tenantId   = rec.get('tenantId')   as string
  const entityType = rec.get('entityType') as string
  const label      = ENTITY_LABELS[entityType]
  if (!label) return

  let parsed: Record<string, string>
  try { parsed = JSON.parse(raw) as Record<string, string> } catch { return }
  const keys = Object.keys(parsed)
  if (keys.length === 0) return

  const nowIso = new Date().toISOString()
  const resolveValue = (v: string) => {
    if (v === '$now')    return nowIso
    if (v === '$userId') return userId
    if (v === '$notes')  return notes ?? null
    return v
  }
  const setClauses = keys.map((k) => `e.\`${k}\` = $__val_${k}`)
  const params: Record<string, unknown> = { entityId, tenantId, now: nowIso }
  for (const [k, v] of Object.entries(parsed)) params[`__val_${k}`] = resolveValue(v)
  await session.executeWrite((tx) => tx.run(
    `MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
     SET ${setClauses.join(', ')}, e.updated_at = $now`,
    params,
  ))
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
      id:            wd['id']              as string,
      name:          wd['name']            as string,
      entityType:    wd['entity_type']     as string,
      changeSubtype: (wd['change_subtype'] ?? null) as string | null,
      version:       Number(wd['version'] ?? 1),
      active:        wd['active']          as boolean,
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
        timerHours:    r.get('timerHours') != null ? Number(r.get('timerHours')) : null,
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
        OPTIONAL MATCH (entity)-[:ASSIGNED_TO]->(assignee)
        OPTIONAL MATCH (entity)-[:ASSIGNED_TO_TEAM]->(team)
        RETURN properties(entity) AS entityData,
               assignee.id AS assigned_to,
               team.id     AS assigned_team
      `, { instanceId }),
    )
    const entityData: Record<string, unknown> =
      entityDataResult.records.length > 0
        ? {
            ...(entityDataResult.records[0].get('entityData') as Record<string, unknown>),
            assigned_to:   entityDataResult.records[0].get('assigned_to') ?? null,
            assigned_team: entityDataResult.records[0].get('assigned_team') ?? null,
          }
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
        // Look up the initial workflow step name for this entity type; fall
        // back to 'open' only if the entity has no workflow defined.
        const { getInitialStepName } = await import('../../lib/workflowHelpers.js')
        let initialStatus: string
        try {
          initialStatus = await getInitialStepName(session, ctx.tenantId, type)
        } catch {
          initialStatus = 'open'
        }
        await session.executeWrite((tx) =>
          tx.run(
            `CREATE (e:${label} $props) RETURN e.id AS id`,
            { props: { id, status: initialStatus, created_at: now, updated_at: now, ...nodeData } },
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

    // Validate required fields for the destination step before allowing transition.
    // Merge entity data with transition notes (notes map to resolution_notes/root_cause).
    if (entityData && Object.keys(entityData).length > 0) {
      const entityTypeRaw = await session.executeRead((tx) =>
        tx.run(`MATCH (wi:WorkflowInstance {id: $instanceId}) RETURN wi.entity_type AS et`, { instanceId }),
      )
      const entityType = entityTypeRaw.records[0]?.get('et') as string | null
      if (entityType) {
        const mergedValues = { ...entityData }
        if (notes) {
          mergedValues['resolution_notes'] = notes
          mergedValues['root_cause']       = notes
        }
        await validateRequiredFields(session, {
          entityType,
          fieldValues: mergedValues,
          tenantId:    ctx.tenantId,
          toStep,
        })
      }
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

        // Generic post-transition: publish an event named after the target
        // step and audit. Field updates (resolved_at, assigned_at, etc.)
        // are driven by the step's `on_enter_fields` metadata, applied below.
        await incidentService.publishIncidentTransition(incidentId, toStep, { tenantId, userId: ctx.userId })
        void audit(ctx, `incident.${toStep}`, 'Incident', incidentId)

        await applyOnEnterFields(session, instanceId, toStep, ctx.userId, notes)

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
        void audit(ctx, `kb_article.${toStep}`, 'KBArticle', kbId)
        await applyOnEnterFields(session, instanceId, toStep, ctx.userId, notes)
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
  { definitionId, transitions, positions, steps }: {
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
    steps?: Array<{
      stepName:     string
      label:        string
      enterActions: string | null
      exitActions:  string | null
      isInitial?:   boolean | null
      isTerminal?:  boolean | null
      isOpen?:      boolean | null
      category?:    string | null
    }> | null
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
    // Update step properties (label, enterActions, exitActions, metadata)
    if (steps && steps.length > 0) {
      await session.executeWrite((tx) =>
        tx.run(`
          UNWIND $steps AS st
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: st.stepName})
          SET s.label         = st.label,
              s.enter_actions = st.enterActions,
              s.exit_actions  = st.exitActions,
              s.is_initial    = coalesce(st.isInitial,  s.is_initial),
              s.is_terminal   = coalesce(st.isTerminal, s.is_terminal),
              s.is_open       = coalesce(st.isOpen,     s.is_open),
              s.category      = coalesce(st.category,   s.category)
        `, { definitionId, tenantId: ctx.tenantId, steps }),
      )

      // If any step was marked isInitial=true, demote the others in the same
      // workflow so there's at most one initial step.
      const initialStepName = steps.find((s) => s.isInitial === true)?.stepName
      if (initialStepName) {
        await session.executeWrite((tx) =>
          tx.run(`
            MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
            WHERE s.name <> $keep
            SET s.is_initial = false
          `, { definitionId, tenantId: ctx.tenantId, keep: initialStepName }),
        )
      }
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
    const savedSteps = stepsResult.records[0]?.get('steps') as Array<{ properties: Record<string, unknown> }> ?? []

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
      id:            wd['id']              as string,
      name:          wd['name']            as string,
      entityType:    wd['entity_type']     as string,
      changeSubtype: (wd['change_subtype'] ?? null) as string | null,
      version:       Number(wd['version'] ?? 1),
      active:        wd['active']          as boolean,
      steps: savedSteps.map((s) => ({
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
        timerHours:    r.get('timerHours') != null ? Number(r.get('timerHours')) : null,
      })),
    }
  }, true)
}
