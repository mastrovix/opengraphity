import { GraphQLError } from 'graphql'
import { ValidationError } from '../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import { workflowEngine, isWorkflowActionType, WORKFLOW_ACTION_TYPES } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { NOTIFICATION_TARGETS, isTargetApplicable, applicableNotificationTargets } from '@opengraphity/types'
import { publish } from '@opengraphity/events'
import { sseManager } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { loadTransitionRows, mapWorkflowDefinition } from './workflowMapping.js'
import * as incidentService from '../../services/incidentService.js'
import { workflowLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import { validateRequiredFields } from '../../lib/validateRequiredFields.js'
import { invalidateWorkflowCache } from '../../lib/workflowHelpers.js'

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
  expectedTenantId?: string,
): Promise<void> {
  const fieldsRow = await session.executeRead((tx) => tx.run(`
    MATCH (wi:WorkflowInstance {id: $instanceId})-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName AND ($tenantId IS NULL OR wi.tenant_id = $tenantId)
    RETURN step.on_enter_fields AS fields,
           wi.entity_id   AS entityId,
           wi.tenant_id   AS tenantId,
           wi.entity_type AS entityType
  `, { instanceId, stepName, tenantId: expectedTenantId ?? null }))
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
  try { parsed = JSON.parse(raw) as Record<string, string> }
  catch (e) {
    // Corrupt on_enter_fields must fail the transition, not silently skip the
    // step's side effects while reporting success.
    throw new GraphQLError(`Corrupt on_enter_fields JSON on step "${stepName}": ${e instanceof Error ? e.message : String(e)}`)
  }
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
      `MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
       // tenant-ok: definizione e step seguono l'istanza appena scopata
       MATCH (wd:WorkflowDefinition {id: wi.definition_id})
       // tenant-ok: idem
       MATCH (s:WorkflowStep {definition_id: wd.id, name: $stepName})
       RETURN s.enter_actions AS enterActions`,
      { instanceId, stepName, tenantId },
    ),
  )
  if (!result.records.length) return
  const raw = result.records[0].get('enterActions') as string | null
  if (!raw) return

  let actions: Array<{ type: string; params?: Record<string, unknown> }>
  try { actions = JSON.parse(raw) }
  catch (e) {
    // Corrupt enter_actions must fail the transition, not silently drop the
    // step's notify rules.
    throw new GraphQLError(`Corrupt enter_actions JSON on step "${stepName}": ${e instanceof Error ? e.message : String(e)}`)
  }

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

// ── Validazione delle azioni in scrittura (B0-5) ──────────────────────────────

/**
 * Valida il JSON delle azioni di un passo PRIMA di scriverlo: lista di oggetti
 * con un `type` del vocabolario del motore. È la porta da cui è entrata la
 * deriva vista dal vivo (un `create_notification` — vocabolario delle
 * automazioni — su un passo di «Incident — Security»): il motore ora ferma la
 * transizione nominando l'azione, ma un dato del genere non deve poter più
 * entrare da qui. `null` = campo non mandato, non si valida nulla.
 *
 * Il `target` di un'azione `notify_rule` viene validato con lo stesso
 * vocabolario delle regole di notifica (`NOTIFICATION_TARGETS`): dal momento in
 * cui il dispatcher RISOLVE i bersagli (A0-1), un bersaglio inesistente qui non
 * è più ignorato — fa fallire il job di notifica a ogni ingresso nel passo. Il
 * pannello del designer offriva `role:admin, role:manager`: il secondo non è un
 * ruolo che l'autenticazione conosce.
 */
export function assertStepActions(raw: string | null | undefined, label: string): void {
  if (raw == null) return
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) {
    throw new GraphQLError(`${label} non è JSON valido (${e instanceof Error ? e.message : String(e)})`, { extensions: { code: 'BAD_USER_INPUT' } })
  }
  if (!Array.isArray(parsed)) {
    throw new GraphQLError(`${label} deve essere una lista di azioni`, { extensions: { code: 'BAD_USER_INPUT' } })
  }
  parsed.forEach((action, i) => {
    const type = (action as { type?: unknown } | null)?.type
    if (!isWorkflowActionType(type)) {
      throw new GraphQLError(
        `${label}[${i}]: azione di tipo ${JSON.stringify(type ?? null)} sconosciuta al motore dei workflow. ` +
        `Ammesse: ${WORKFLOW_ACTION_TYPES.join(', ')}.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      )
    }
    if (type === 'notify_rule') {
      const target = (action as { params?: Record<string, unknown> }).params?.['target']
      if (target != null && target !== '') {
        const t = String(target)
        if (!(NOTIFICATION_TARGETS as readonly string[]).includes(t)) {
          throw new GraphQLError(
            `${label}[${i}]: target "${t}" non è un destinatario valido. Ammessi: ${NOTIFICATION_TARGETS.join(', ')}.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          )
        }
        if (!isTargetApplicable('workflow.step.entered', t)) {
          throw new GraphQLError(
            `${label}[${i}]: target "${t}" non può essere risolto all'ingresso in un passo. ` +
            `Applicabili: ${applicableNotificationTargets('workflow.step.entered').join(', ')}.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          )
        }
      }
    }
  })
}

// ── Marchio di personalizzazione (contratto con i seed, ondata 2) ─────────────

/**
 * Ogni mutation che cambia una definizione di workflow o i suoi passi e
 * transizioni marchia la definizione come «toccata dall'amministratore».
 * È il contratto che i seed leggono (B-2): un seed che rieseguirebbe sopra una
 * definizione marchiata si rifiuta, e il rifiuto nomina data e autore.
 *
 * `saveWorkflowLayout` NON marchia: la posizione dei nodi sul canvas non è
 * configurazione di processo, e un seed che la sovrascrive non toglie niente
 * al cliente.
 */
export const MARK_CUSTOMIZED = 'SET wd.customized_at = $customizedAt, wd.customized_by = $customizedBy'

/** Parametri di `MARK_CUSTOMIZED`; da unire a quelli della query. */
export function customizedParams(ctx: GraphQLContext): { customizedAt: string; customizedBy: string } {
  return { customizedAt: new Date().toISOString(), customizedBy: ctx.userId }
}

// ── Mutation resolvers ────────────────────────────────────────────────────────

export async function updateWorkflowStep(
  _: unknown,
  { definitionId, stepName, label, enterActions, exitActions }: { definitionId: string; stepName: string; label: string; enterActions?: string | null; exitActions?: string | null },
  ctx: GraphQLContext,
) {
  assertStepActions(enterActions, `enter_actions dello step "${stepName}"`)
  assertStepActions(exitActions,  `exit_actions dello step "${stepName}"`)
  return withSession(async (session) => {
    const now = new Date().toISOString()
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
        SET s.label        = $label,
            s.updated_at   = $now,
            s.enter_actions = CASE WHEN $enterActions IS NOT NULL THEN $enterActions ELSE s.enter_actions END,
            s.exit_actions  = CASE WHEN $exitActions  IS NOT NULL THEN $exitActions  ELSE s.exit_actions  END
        ${MARK_CUSTOMIZED}
        RETURN s, wd.entity_type AS entityType
      `, { definitionId, stepName, tenantId: ctx.tenantId, label, enterActions: enterActions ?? null, exitActions: exitActions ?? null, now, ...customizedParams(ctx) }),
    )
    if (!result.records.length) throw new GraphQLError('WorkflowStep non trovato', { extensions: { code: 'NOT_FOUND' } })
    invalidateWorkflowCache(ctx.tenantId, result.records[0].get('entityType') as string)
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
        // tenant-ok: la definizione dello step di partenza è scopata alla riga dopo
        MATCH (src:WorkflowStep)-[t:TRANSITIONS_TO {id: $transitionId}]->()
        MATCH (wd:WorkflowDefinition {id: src.definition_id, tenant_id: $tenantId})
        ${MARK_CUSTOMIZED}
        SET t.label          = coalesce($label, t.label),
            t.trigger        = coalesce($trigger, t.trigger),
            t.requires_input = $requiresInput,
            t.input_field    = coalesce($inputField, t.input_field),
            t.condition      = coalesce($condition, t.condition),
            t.timer_hours    = coalesce($timerHours, t.timer_hours)
      `, {
        transitionId,
        tenantId: ctx.tenantId,
        ...customizedParams(ctx),
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
    if (!wdResult.records.length) throw new GraphQLError('WorkflowDefinition non trovata', { extensions: { code: 'NOT_FOUND' } })
    const wd    = wdResult.records[0].get('wd').properties    as Record<string, unknown>
    const steps = wdResult.records[0].get('steps') as Array<{ properties: Record<string, unknown> }>
    invalidateWorkflowCache(ctx.tenantId, wd['entity_type'] as string)
    const transitions = await loadTransitionRows(session, definitionId, ctx.tenantId)
    return mapWorkflowDefinition(wd, steps, transitions)
  }, true)
}

/**
 * Creates a new transition (arrow) between two steps of a definition — the
 * write path the Workflow Designer's onConnect calls. Persists the drawn
 * handles so the edge re-renders where the user placed it. Trigger defaults to
 * 'manual'; the user then edits it (e.g. to 'sla_breach') via the transition
 * panel + saveWorkflowChanges.
 */
export async function addWorkflowTransition(
  _: unknown,
  { definitionId, fromStepName, toStepName, trigger, label, sourceHandle, targetHandle }: {
    definitionId: string; fromStepName: string; toStepName: string
    trigger?: string | null; label?: string | null
    sourceHandle?: string | null; targetHandle?: string | null
  },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const id = uuidv4()
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok: step della definizione appena scopata
        MATCH (from:WorkflowStep {definition_id: $definitionId, name: $fromStepName})
        // tenant-ok: idem
        MATCH (to:WorkflowStep   {definition_id: $definitionId, name: $toStepName})
        CREATE (from)-[tr:TRANSITIONS_TO {
          id: $id, trigger: $trigger, label: $label,
          requires_input: false, input_field: null, condition: null, timer_hours: null,
          source_handle: $sourceHandle, target_handle: $targetHandle
        }]->(to)
        ${MARK_CUSTOMIZED}
        RETURN tr, from.name AS fromStep, to.name AS toStep, wd.entity_type AS entityType
      `, {
        definitionId, tenantId: ctx.tenantId, fromStepName, toStepName, id,
        trigger: trigger ?? 'manual', label: label ?? 'Nuova transizione',
        sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null,
        ...customizedParams(ctx),
      }),
    )
    if (!result.records.length) {
      throw new GraphQLError('Step non trovati o non appartenenti a questa definizione', { extensions: { code: 'NOT_FOUND' } })
    }
    invalidateWorkflowCache(ctx.tenantId, result.records[0].get('entityType') as string)
    const tr = result.records[0].get('tr').properties as Record<string, unknown>
    return {
      id,
      fromStepName:  result.records[0].get('fromStep') as string,
      toStepName:    result.records[0].get('toStep')   as string,
      trigger:       tr['trigger']        as string,
      label:         tr['label']          as string,
      requiresInput: false,
      inputField:    null,
      condition:     null,
      timerHours:    null,
      sourceHandle:  (tr['source_handle'] ?? null) as string | null,
      targetHandle:  (tr['target_handle'] ?? null) as string | null,
    }
  }, true)
}

/** Deletes a transition by id (Workflow Designer edge removal). */
export async function removeWorkflowTransition(
  _: unknown,
  { definitionId, transitionId }: { definitionId: string; transitionId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        // tenant-ok: step della definizione appena scopata
        MATCH (:WorkflowStep {definition_id: $definitionId})-[tr:TRANSITIONS_TO {id: $transitionId}]->()
        ${MARK_CUSTOMIZED}
        WITH wd, tr, tr.id AS deletedId
        DELETE tr
        RETURN deletedId, wd.entity_type AS entityType
      `, { definitionId, tenantId: ctx.tenantId, transitionId, ...customizedParams(ctx) }),
    )
    if (!result.records.length) return false
    invalidateWorkflowCache(ctx.tenantId, result.records[0].get('entityType') as string)
    return true
  }, true)
}

/**
 * Valida i metadati JSON dello step di arrivo (on_enter_fields, enter_actions)
 * prima di transizionare: se corrotti, la mutation fallisce SENZA aver
 * avanzato il workflow.
 */
async function preflightStepMetadata(
  session: import('neo4j-driver').Session,
  instanceId: string,
  toStep: string,
  tenantId: string,
): Promise<void> {
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
    // tenant-ok: step della definizione dell'istanza scopata
    MATCH (s:WorkflowStep {definition_id: wi.definition_id, name: $toStep})
    RETURN s.on_enter_fields AS fields, s.enter_actions AS enterActions
  `, { instanceId, toStep, tenantId }))
  if (!res.records.length) return // lo step non esiste: sarà l'engine a rifiutare la transizione
  const rec = res.records[0]
  for (const [key, label] of [['fields', 'on_enter_fields'], ['enterActions', 'enter_actions']] as const) {
    const raw = rec.get(key) as string | null
    if (!raw) continue
    try { JSON.parse(raw) } catch (e) {
      throw new GraphQLError(`Workflow mal configurato: ${label} dello step "${toStep}" non è JSON valido (${e instanceof Error ? e.message : String(e)})`, { extensions: { code: 'CONFLICT' } })
    }
  }
}

export async function executeWorkflowTransition(
  _: unknown,
  { instanceId, toStep, notes }: { instanceId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Tenant-isolation guard: the instance must belong to the caller's tenant.
    // Everything downstream (engine.transition, re-reads by instanceId) relies
    // on this check having passed.
    // Pre-fetch entity data for template/condition evaluation in actions
    const entityDataResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
        OPTIONAL MATCH (entity {id: wi.entity_id, tenant_id: $tenantId})
        OPTIONAL MATCH (entity)-[:ASSIGNED_TO]->(assignee)
        OPTIONAL MATCH (entity)-[:ASSIGNED_TO_TEAM]->(team)
        RETURN properties(entity) AS entityData,
               assignee.id AS assigned_to,
               team.id     AS assigned_team,
               wi.entity_type AS entityType
      `, { instanceId, tenantId: ctx.tenantId }),
    )
    if (entityDataResult.records.length === 0) {
      throw new GraphQLError(`Workflow instance not found: ${instanceId}`, { extensions: { code: 'NOT_FOUND' } })
    }
    // Le change hanno un gate di approvazione multi-parte e side-effect di
    // fase (task, approvazioni, rischio) che vivono in executeChangeTransition:
    // la mutation generica NON deve poter aggirarli.
    if (entityDataResult.records[0].get('entityType') === 'change') {
      throw new GraphQLError('Le change si transizionano con executeChangeTransition (gate di approvazione e side-effect di fase)', { extensions: { code: 'CONFLICT' } })
    }
    const entityData: Record<string, unknown> = {
      ...((entityDataResult.records[0].get('entityData') as Record<string, unknown> | null) ?? {}),
      assigned_to:   entityDataResult.records[0].get('assigned_to') ?? null,
      assigned_team: entityDataResult.records[0].get('assigned_team') ?? null,
    }

    const actionCtx: ActionContext = {
      userId:     ctx.userId,
      notes,
      entityData,

      createEntity: async (type, data) => {
        const label = ENTITY_LABELS[type]
        if (!label) throw new ValidationError(`Unknown entity type: ${type}`)

        // Extract relation metadata — must not be stored as node properties
        const { parent_id, parent_type, ...nodeData } = data as Record<string, unknown>

        const id = uuidv4()
        const now = new Date().toISOString()
        // Look up the initial workflow step name for this entity type; fall
        // back to 'open' only if the entity has no workflow defined.
        // No silent 'open' fallback: an entity type without a defined initial
        // step is a misconfiguration and must fail loudly, not be created in a
        // phantom status the workflow doesn't recognise.
        const { getInitialStepName } = await import('../../lib/workflowHelpers.js')
        const initialStatus = await getInitialStepName(session, ctx.tenantId, type)
        await session.executeWrite((tx) =>
          tx.run(
            `CREATE (e:${label} $props) RETURN e.id AS id`,
            { props: { id, tenant_id: ctx.tenantId, status: initialStatus, created_at: now, updated_at: now, ...nodeData } },
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
                `MATCH (child:${childLabel} {id: $childId, tenant_id: $tenantId})
                 MATCH (parent:${parentLabelFinal} {id: $parentId, tenant_id: $tenantId})
                 MERGE (child)-[:${relType}]->(parent)`,
                { childId: id, parentId: parent_id, tenantId: ctx.tenantId },
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
        if (approverIds.length === 0) {
          throw new GraphQLError(`Nessun utente con ruolo "${approverRole ?? 'admin'}" configurato per approvare`, { extensions: { code: 'NO_APPROVER' } })
        }
        const finalApprovers = approverIds

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
        tx.run(`MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId}) RETURN wi.entity_type AS et`, { instanceId, tenantId: ctx.tenantId }),
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

    // I metadati dello step di arrivo (on_enter_fields, enter_actions) vengono
    // validati PRIMA della transizione: un JSON corrotto deve bloccare, non
    // far fallire la mutation dopo che il workflow è già avanzato.
    await preflightStepMetadata(session, instanceId, toStep, ctx.tenantId)

    workflowLogger.debug({ toStep, instanceId }, 'Transitioning workflow step')
    const result = await workflowEngine.transition(
      session,
      {
        instanceId,
        toStepName:  toStep,
        triggeredBy: ctx.userId,
        triggerType: 'manual',
        notes,
        tenantId:    ctx.tenantId,
      },
      actionCtx,
    )
    // Side-effect post-commit falliti: la transizione è già persistita, quindi
    // NON si lancia (l'utente vedrebbe "fallito" con il workflow avanzato) ma
    // finiscono in actionErrors, come quelli dell'engine.
    const postErrors: string[] = []
    const post = async (what: string, fn: () => Promise<unknown>) => {
      try { await fn() } catch (e) {
        const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`
        workflowLogger.error({ instanceId, toStep, err: e }, `[workflow] post-transition side effect failed — ${what}`)
        postErrors.push(msg)
      }
    }
    workflowLogger.debug({ instanceId, success: result.success }, 'Workflow transition result')

    if (result.success) {
      const wiResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
          WHERE wi.entity_type = 'incident'
          MATCH (i:Incident {id: wi.entity_id, tenant_id: wi.tenant_id})
          OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci:ConfigurationItem)
          OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
          OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
          RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status,
                 wi.tenant_id AS tenantId,
                 collect(DISTINCT ci.name)[0] AS ciName,
                 u.name AS assignedTo, t.name AS teamName
        `, { instanceId, tenantId: ctx.tenantId }),
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
        await post('publish incident transition', () => incidentService.publishIncidentTransition(incidentId, toStep, { tenantId, userId: ctx.userId }))
        void audit(ctx, `incident.${toStep}`, 'Incident', incidentId)

        await post('on_enter_fields', () => applyOnEnterFields(session, instanceId, toStep, ctx.userId, notes, ctx.tenantId))

        // Publish workflow.step.entered for any notify_rule enter_actions on this step
        // (SLA pause/resume is driven by the step's own sla_pause/sla_resume
        // enter/exit actions, consumed by the SLA engine — see packages/sla.)
        await post('notify rules', () => publishNotifyRuleActions(session, instanceId, toStep, tenantId, ctx.userId, 'incident', incidentId))
      }

      // ── KB Article post-transition ────────────────────────────────────────
      const kbResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
          WHERE wi.entity_type = 'kb_article'
          MATCH (a:KBArticle {id: wi.entity_id, tenant_id: wi.tenant_id})
          RETURN a.id AS id, wi.tenant_id AS tenantId, a.requested_by AS requestedBy
        `, { instanceId, tenantId: ctx.tenantId }),
      )
      if (kbResult.records.length > 0) {
        const kbId     = kbResult.records[0].get('id')     as string
        const tenantId = kbResult.records[0].get('tenantId') as string
        void audit(ctx, `kb_article.${toStep}`, 'KBArticle', kbId)
        await post('on_enter_fields', () => applyOnEnterFields(session, instanceId, toStep, ctx.userId, notes, ctx.tenantId))
        await post('notify rules', () => publishNotifyRuleActions(session, instanceId, toStep, tenantId, ctx.userId, 'kb_article', kbId))
      }
    }

    if (result.actionErrors?.length) {
      workflowLogger.error({ instanceId, actionErrors: result.actionErrors },
        '[workflow] transition persisted but step actions failed')
    }
    const allActionErrors = [...(result.actionErrors ?? []), ...postErrors]

    return {
      success:      result.success,
      error:        result.error ?? null,
      instance:     result.instance ?? null,
      actionErrors: allActionErrors.length > 0 ? allActionErrors : null,
    }
  }, true)
}

export async function saveWorkflowChanges(
  _: unknown,
  { definitionId, transitions, positions, steps, expectedVersion }: {
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
    /** Optimistic lock: versione letta dal client. Null = nessun controllo. */
    expectedVersion?: number | null
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  // Azioni validate PRIMA di aprire la transazione (B0-5): un tipo fuori
  // vocabolario non entra nel grafo dal disegnatore.
  for (const st of steps ?? []) {
    assertStepActions(st.enterActions, `enter_actions dello step "${st.stepName}"`)
    assertStepActions(st.exitActions,  `exit_actions dello step "${st.stepName}"`)
  }
  return withSession(async (session) => {
    // Tutto in UNA transazione: controllo di versione, aggiornamenti e
    // incremento. Prima erano write separate senza confronto di versione →
    // last-writer-wins silenzioso tra due designer aperti sullo stesso workflow.
    const wd = await session.executeWrite(async (tx) => {
      const cur = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        RETURN wd.version AS version
      `, { definitionId, tenantId: ctx.tenantId })
      if (!cur.records.length) throw new GraphQLError('WorkflowDefinition non trovata', { extensions: { code: 'NOT_FOUND' } })
      const currentVersion = Number(cur.records[0].get('version') ?? 1)
      if (expectedVersion != null && currentVersion !== expectedVersion) {
        throw new GraphQLError(
          `Workflow modificato da un altro utente (versione ${currentVersion}, tu stavi modificando la v${expectedVersion}). Ricarica la pagina per non sovrascrivere le sue modifiche.`,
          { extensions: { code: 'CONFLICT', currentVersion, expectedVersion } },
        )
      }

      // Update each transition
      if (transitions.length > 0) {
        await tx.run(`
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
          UNWIND $transitions AS tr
          // tenant-ok: wd già scopata sopra
          MATCH (src:WorkflowStep {definition_id: wd.id})-[t:TRANSITIONS_TO {id: tr.transitionId}]->()
          SET t.label          = coalesce(tr.label, t.label),
              t.trigger        = coalesce(tr.trigger, t.trigger),
              t.requires_input = tr.requiresInput,
              t.input_field    = tr.inputField,
              t.condition      = tr.condition,
              t.timer_hours    = tr.timerHours
        `, { transitions, definitionId, tenantId: ctx.tenantId })
      }
      // Update step properties (label, enterActions, exitActions, metadata)
      if (steps && steps.length > 0) {
        // Un passo non può essere insieme iniziale e terminale: il processo
        // nascerebbe già chiuso (B-8). Il controllo tiene conto sia di quello
        // che questa chiamata sta scrivendo sia di quello che c'è nel grafo.
        const wantsInitial = steps.filter((s) => s.isInitial === true)
        if (wantsInitial.length > 1) {
          throw new GraphQLError(
            `Un solo step può essere iniziale: ne hai marcati ${wantsInitial.length} (${wantsInitial.map((s) => s.stepName).join(', ')}).`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          )
        }
        const initial = wantsInitial[0]
        if (initial) {
          const cur = await tx.run(`
            MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: $stepName})
            RETURN coalesce(s.is_terminal, s.type = 'end') AS terminal
          `, { definitionId, tenantId: ctx.tenantId, stepName: initial.stepName })
          if (!cur.records.length) {
            throw new GraphQLError(`Step "${initial.stepName}" non trovato in questa definizione`, { extensions: { code: 'NOT_FOUND' } })
          }
          const terminalAfter = initial.isTerminal ?? Boolean(cur.records[0].get('terminal'))
          if (terminalAfter) {
            throw new GraphQLError(
              `Lo step "${initial.stepName}" è terminale: non può essere anche lo step iniziale, ` +
              `altrimenti ogni nuovo ticket nascerebbe già chiuso. Togli «Step terminale» oppure scegli un altro step iniziale.`,
              { extensions: { code: 'BAD_USER_INPUT' } },
            )
          }
        }
        await tx.run(`
          UNWIND $steps AS st
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep {name: st.stepName})
          SET s.label         = st.label,
              s.enter_actions = st.enterActions,
              s.exit_actions  = st.exitActions,
              s.is_initial    = coalesce(st.isInitial,  s.is_initial),
              s.is_terminal   = coalesce(st.isTerminal, s.is_terminal),
              s.is_open       = coalesce(st.isOpen,     s.is_open),
              s.category      = coalesce(st.category,   s.category)
        `, { definitionId, tenantId: ctx.tenantId, steps })

        // If any step was marked isInitial=true, demote the others in the same
        // workflow so there's at most one initial step.
        const initialStepName = steps.find((s) => s.isInitial === true)?.stepName
        if (initialStepName) {
          await tx.run(`
            MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep)
            WHERE s.name <> $keep
            SET s.is_initial = false
          `, { definitionId, tenantId: ctx.tenantId, keep: initialStepName })
        }
      }
      // Update step positions
      if (positions.length > 0) {
        await tx.run(`
          UNWIND $positions AS pos
          MATCH (s:WorkflowStep {id: pos.stepId})<-[:HAS_STEP]-(wd:WorkflowDefinition {
            id: $definitionId, tenant_id: $tenantId
          })
          SET s.position_x = pos.positionX,
              s.position_y = pos.positionY
        `, { definitionId, tenantId: ctx.tenantId, positions })
      }
      // Increment version (dopo il check, nella stessa tx)
      const wdResult = await tx.run(`
        MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
        SET wd.version    = wd.version + 1,
            wd.updated_at = $now
        ${MARK_CUSTOMIZED}
        RETURN wd
      `, { definitionId, tenantId: ctx.tenantId, now, ...customizedParams(ctx) })
      if (!wdResult.records.length) throw new GraphQLError('WorkflowDefinition non trovata', { extensions: { code: 'NOT_FOUND' } })
      return wdResult.records[0].get('wd').properties as Record<string, unknown>
    })

    invalidateWorkflowCache(ctx.tenantId, wd['entity_type'] as string)
    void audit(ctx, 'workflow.updated', 'WorkflowDefinition', definitionId)

    const stepsResult = await session.executeRead((tx) =>
      tx.run(`MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})-[:HAS_STEP]->(s:WorkflowStep) RETURN collect(s) AS steps`,
        { definitionId, tenantId: ctx.tenantId }),
    )
    const savedSteps = stepsResult.records[0]?.get('steps') as Array<{ properties: Record<string, unknown> }> ?? []
    // NB: nome diverso dal parametro `transitions`. Quando questa variabile si
    // chiamava come lui, il `transitions.length` dentro la transazione leggeva
    // QUESTA (zona morta temporale) e la mutation falliva sempre con un
    // ReferenceError — «Salva modifiche» del disegnatore non salvava niente.
    const savedTransitions = await loadTransitionRows(session, definitionId, ctx.tenantId)
    return mapWorkflowDefinition(wd, savedSteps, savedTransitions)
  }, true)
}
