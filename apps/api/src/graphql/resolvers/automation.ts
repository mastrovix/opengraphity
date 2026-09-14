import { v4 as uuidv4 } from 'uuid'
import { withSession } from './ci-utils.js'
import { runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { invalidateTriggerCache } from '../../lib/triggerEngine.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { invalidateRulesCache } from '../../lib/rulesEngine.js'
import { parseConditions, type ConditionOperator } from '../../lib/conditionEvaluator.js'
import { parseActions, type ActionType } from '../../lib/actionExecutor.js'
import { ValidationError } from '../../lib/errors.js'
import { getWorkflowSteps } from '../../lib/workflowHelpers.js'
import type { Session } from 'neo4j-driver'
import { selectSLAForEntity, getTenantTimezone } from '@opengraphity/sla'
import { SLA_ENTITY_TYPES, SLA_CATEGORY_ENTITY_TYPES } from '@opengraphity/types'

type Props = Record<string, unknown>

// ── Write-time validation (C-16) ─────────────────────────────────────────────
// Conditions/actions are stored as JSON strings and parsed by the SAME parsers
// the runtime uses. Before, corrupt JSON or an unknown event type was accepted
// and the rule failed only at runtime (log line only): the rule looked enabled
// while never firing.

export const AUTOMATION_ENTITY_TYPES  = ['incident', 'change', 'problem', 'service_request'] as const
export const TRIGGER_EVENT_TYPES      = ['on_create', 'on_update', 'on_timer', 'on_sla_breach', 'on_field_change'] as const
export const RULE_EVENT_TYPES         = ['on_create', 'on_update', 'on_transition'] as const
export const CONDITION_LOGICS         = ['and', 'or'] as const
const CONDITION_OPERATORS: readonly ConditionOperator[] = ['equals', 'not_equals', 'is_null', 'is_not_null', 'greater_than', 'less_than', 'contains']
const ACTION_TYPES: readonly ActionType[] = ['set_field', 'assign_team', 'assign_user', 'transition_workflow', 'create_notification', 'create_comment', 'set_priority', 'execute_script', 'call_webhook', 'set_sla']

function assertEnum(field: string, value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field} ${JSON.stringify(value)} — expected one of: ${allowed.join(', ')}`)
  }
  return value
}

/** Validates a conditions JSON string (null/empty = no conditions). Returns the normalised string to store. */
export function assertConditionsJson(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') throw new ValidationError('conditions must be a JSON string')
  let conditions
  try {
    conditions = parseConditions(raw)
  } catch (err) {
    throw new ValidationError(`Invalid conditions: ${err instanceof Error ? err.message : String(err)}`)
  }
  conditions.forEach((c, i) => {
    if (!c || typeof c !== 'object') throw new ValidationError(`Invalid conditions: item ${i} is not an object`)
    if (typeof c.field !== 'string' || !c.field) throw new ValidationError(`Invalid conditions: item ${i} has no field`)
    if (!CONDITION_OPERATORS.includes(c.operator)) {
      throw new ValidationError(`Invalid conditions: item ${i} has unknown operator ${JSON.stringify(c.operator)} — expected one of: ${CONDITION_OPERATORS.join(', ')}`)
    }
  })
  return raw
}

/** Validates an actions JSON string (null/empty = no actions). Returns the normalised string to store. */
export function assertActionsJson(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') throw new ValidationError('actions must be a JSON string')
  let actions
  try {
    actions = parseActions(raw)
  } catch (err) {
    throw new ValidationError(`Invalid actions: ${err instanceof Error ? err.message : String(err)}`)
  }
  actions.forEach((a, i) => {
    if (!a || typeof a !== 'object') throw new ValidationError(`Invalid actions: item ${i} is not an object`)
    if (!ACTION_TYPES.includes(a.type)) {
      throw new ValidationError(`Invalid actions: item ${i} has unknown type ${JSON.stringify(a.type)} — expected one of: ${ACTION_TYPES.join(', ')}`)
    }
    if (a.params != null && (typeof a.params !== 'object' || Array.isArray(a.params))) {
      throw new ValidationError(`Invalid actions: item ${i} params must be an object`)
    }
  })
  return raw
}

// ── Bersagli di passo in scrittura (ondata 8 · B-18) ─────────────────────────

/**
 * Valida i **nomi di passo** che un'automazione nomina, contro i passi veri
 * del workflow di QUESTO cliente: `transition_workflow.to_step` e le
 * condizioni di uguaglianza su `status`.
 *
 * ## Il difetto
 * `assertActionsJson` controllava il *tipo* dell'azione ma non il suo
 * bersaglio. Una regola che punta a un passo che non esiste (rinominato,
 * tolto, o mai esistito) risultava **attiva e sana**: a ogni esecuzione il
 * motore rifiutava la transizione e nessuno lo vedeva. Dal vivo: la regola
 * «Change emergency → approvazione immediata» di un tenant reale punta al
 * passo `approved`, che il workflow change non ha — l'auto-approvazione delle
 * emergency non è mai avvenuta.
 *
 * ## La regola
 * Il nome del passo non lo decide questo file: lo si chiede al workflow del
 * tenant (`getWorkflowSteps`, che unisce le definizioni attive dell'entità).
 * Un bersaglio fuori elenco è rifiutato **nominando i passi esistenti**, così
 * chi salva sa subito cosa scegliere. È la stessa forma di `assertStepActions`
 * per le azioni di passo (ondata 2).
 *
 * Solo `equals`/`not_equals` sulle condizioni: `contains` su `status` può
 * essere un prefisso legittimo, e `is_null` non nomina un passo.
 */
export async function assertStepTargets(
  session: Session,
  tenantId: string,
  entityType: string,
  opts: { actions?: string | null; conditions?: string | null },
): Promise<void> {
  const hasActionTarget    = opts.actions    != null && opts.actions.includes('transition_workflow')
  const hasStatusCondition = opts.conditions != null && opts.conditions.includes('"status"')
  if (!hasActionTarget && !hasStatusCondition) return

  const steps = await getWorkflowSteps(session, tenantId, entityType)
  const names = steps.map((s) => s.name)
  const known = new Set(names)
  const nameList = names.length > 0 ? names.join(', ') : '(nessuno)'

  const reject = (what: string, value: string): never => {
    throw new ValidationError(
      names.length === 0
        ? `${what} names the step "${value}", but the "${entityType}" workflow of this tenant has no step at all: `
          + `create the workflow definition before configuring the automation.`
        : `${what} names the step "${value}", which does not exist in the "${entityType}" workflow of this tenant. `
          + `Available steps: ${nameList}.`,
      names.length === 0
        ? { key: 'errors.automation.noStepsAtAll', params: { what, step: value, entityType } }
        : { key: 'errors.automation.unknownStep', params: { what, step: value, entityType, available: nameList } },
    )
  }

  if (hasActionTarget) {
    parseActions(opts.actions).forEach((a, i) => {
      if (a?.type !== 'transition_workflow') return
      const toStep = a.params?.['to_step']
      if (toStep == null || String(toStep).trim() === '') {
        throw new ValidationError(`Invalid actions: item ${i} (transition_workflow) needs the destination step (to_step).`, { key: 'errors.automation.transitionNeedsStep', params: { item: i } })
      }
      if (!known.has(String(toStep))) reject(`Invalid actions: item ${i} (transition_workflow)`, String(toStep))
    })
  }

  if (hasStatusCondition) {
    parseConditions(opts.conditions ?? null).forEach((c, i) => {
      if (c?.field !== 'status') return
      if (c.operator !== 'equals' && c.operator !== 'not_equals') return
      const value = c.value
      if (value == null || String(value).trim() === '') return
      if (!known.has(String(value))) reject(`Invalid conditions: item ${i} (status ${c.operator})`, String(value))
    })
  }
}

/** L'`entity_type` salvato sul nodo: non è modificabile, quindi si legge da lì per validare un aggiornamento. */
async function entityTypeOf(session: Session, label: 'AutoTrigger' | 'BusinessRule', id: string, tenantId: string): Promise<string> {
  const rows = await runQuery<{ entityType: string }>(session, `
    MATCH (n:${label} {id: $id, tenant_id: $tenantId})
    RETURN n.entity_type AS entityType
  `, { id, tenantId })
  const found = rows[0]?.entityType
  if (!found) throw new ValidationError(`${label} ${id} not found`, { key: 'errors.notFound', params: { entity: label, id } })
  return found
}

function assertTimerDelay(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`Invalid timerDelayMinutes ${JSON.stringify(value)} — expected a non-negative integer`)
  }
  return value
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapTrigger(p: Props) {
  return {
    id:                p['id'],
    name:              p['name'],
    entityType:        p['entity_type'],
    eventType:         p['event_type'],
    conditions:        p['conditions']     ?? null,
    timerDelayMinutes: p['timer_delay_minutes'] != null ? Number(p['timer_delay_minutes']) : null,
    actions:           p['actions']         ?? null,
    enabled:           p['enabled']         ?? false,
    executionCount:    Number(p['execution_count'] ?? 0),
    lastExecutedAt:    p['last_executed_at'] ?? null,
  }
}

function mapRule(p: Props) {
  return {
    id:             p['id'],
    name:           p['name'],
    description:    p['description']     ?? null,
    entityType:     p['entity_type'],
    eventType:      p['event_type'],
    conditionLogic: p['condition_logic'] ?? 'and',
    conditions:     p['conditions']      ?? null,
    actions:        p['actions']         ?? null,
    priority:       Number(p['priority'] ?? 100),
    stopOnMatch:    p['stop_on_match']   ?? false,
    enabled:        p['enabled']         ?? false,
  }
}

function mapSLAPolicy(p: Props, teamName?: string | null) {
  return {
    id:              p['id'],
    name:            p['name'],
    entityType:      p['entity_type'],
    priority:        p['priority']         ?? null,
    category:        p['category']         ?? null,
    teamId:          p['team_id']          ?? null,
    teamName:        teamName              ?? null,
    timezone:        p['timezone']         ?? 'Europe/Rome',
    responseMinutes: Number(p['response_minutes'] ?? 0),
    resolveMinutes:  Number(p['resolve_minutes']  ?? 0),
    businessHours:   p['business_hours']   ?? false,
    enabled:         p['enabled']          ?? true,
  }
}

// ── Sort helper ──────────────────────────────────────────────────────────────

function resolveSort(alias: string, sortField: string | undefined, sortDirection: string | undefined, whitelist: Record<string, string>, defaultField: string): string {
  const col = whitelist[sortField ?? ''] ?? `${alias}.${defaultField}`
  const dir = sortDirection === 'asc' ? 'ASC' : 'DESC'
  return `ORDER BY ${col} ${dir}`
}

// ── Auto Triggers ────────────────────────────────────────────────────────────

async function autoTriggers(_: unknown, args: { entityType?: string; filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const params: Props = { tenantId: ctx.tenantId, entityType: args.entityType ?? null }
    const filter = args.entityType ? 'AND t.entity_type = $entityType' : ''
    const allowed = new Set(['name', 'entityType', 'eventType', 'enabled', 'executionCount', 'entity_type', 'event_type', 'execution_count'])
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 't') : ''
    const order = resolveSort('t', args.sortField, args.sortDirection, { name: 't.name', entityType: 't.entity_type', eventType: 't.event_type', enabled: 't.enabled', executionCount: 't.execution_count' }, 'name')
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (t:AutoTrigger {tenant_id: $tenantId})
      WHERE true ${filter} ${advWhere ? `AND (${advWhere})` : ''}
      RETURN properties(t) AS props
      ${order}
    `, params)
    return rows.map(r => mapTrigger(r.props))
  })
}

async function createAutoTrigger(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()
  const entityType        = assertEnum('entityType', input['entityType'], AUTOMATION_ENTITY_TYPES)
  const eventType         = assertEnum('eventType', input['eventType'], TRIGGER_EVENT_TYPES)
  const conditions        = assertConditionsJson(input['conditions'])
  const actions           = assertActionsJson(input['actions'])
  const timerDelayMinutes = assertTimerDelay(input['timerDelayMinutes'])
  if (eventType === 'on_timer' && (timerDelayMinutes == null || timerDelayMinutes <= 0)) {
    throw new ValidationError('An on_timer trigger requires timerDelayMinutes > 0')
  }
  return withSession(async (session) => {
    await assertStepTargets(session, ctx.tenantId, entityType, { actions, conditions })
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (t:AutoTrigger {
        id: $id, tenant_id: $tenantId,
        name: $name, entity_type: $entityType, event_type: $eventType,
        conditions: $conditions, timer_delay_minutes: $timerDelayMinutes,
        actions: $actions, enabled: $enabled,
        execution_count: 0, last_executed_at: null,
        created_at: $now, updated_at: $now
      })
      RETURN properties(t) AS props
    `, {
      id, tenantId: ctx.tenantId,
      name: input['name'], entityType, eventType,
      conditions,
      timerDelayMinutes,
      actions,
      enabled: input['enabled'] ?? true, now,
    })
    invalidateTriggerCache(ctx.tenantId)
    return mapTrigger(rows[0]!.props)
  }, true)
}

async function updateAutoTrigger(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  const sets: string[] = ['t.updated_at = $now']
  const params: Props = { id: args.id, tenantId: ctx.tenantId, now: new Date().toISOString() }
  const fieldMap: Record<string, string> = {
    name: 'name', eventType: 'event_type', conditions: 'conditions',
    timerDelayMinutes: 'timer_delay_minutes', actions: 'actions', enabled: 'enabled',
  }
  const validators: Record<string, (v: unknown) => unknown> = {
    eventType:         (v) => assertEnum('eventType', v, TRIGGER_EVENT_TYPES),
    conditions:        assertConditionsJson,
    actions:           assertActionsJson,
    timerDelayMinutes: assertTimerDelay,
  }
  for (const [gql, neo] of Object.entries(fieldMap)) {
    if (args.input[gql] !== undefined) {
      sets.push(`t.${neo} = $${gql}`)
      params[gql] = validators[gql] ? validators[gql](args.input[gql]) : args.input[gql]
    }
  }
  return withSession(async (session) => {
    if (args.input['actions'] !== undefined || args.input['conditions'] !== undefined) {
      const entityType = await entityTypeOf(session, 'AutoTrigger', args.id, ctx.tenantId)
      await assertStepTargets(session, ctx.tenantId, entityType, {
        actions:    params['actions']    as string | null | undefined,
        conditions: params['conditions'] as string | null | undefined,
      })
    }
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (t:AutoTrigger {id: $id, tenant_id: $tenantId})
      SET ${sets.join(', ')}
      RETURN properties(t) AS props
    `, params)
    invalidateTriggerCache(ctx.tenantId)
    return mapTrigger(rows[0]!.props)
  }, true)
}

async function deleteAutoTrigger(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  await withSession(async (session) => {
    await runQuery(session, `MATCH (t:AutoTrigger {id: $id, tenant_id: $tenantId}) DETACH DELETE t`, { id: args.id, tenantId: ctx.tenantId })
  }, true)
  invalidateTriggerCache(ctx.tenantId)
  return true
}

// ── Business Rules ───────────────────────────────────────────────────────────

async function businessRules(_: unknown, args: { entityType?: string; filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const params: Props = { tenantId: ctx.tenantId, entityType: args.entityType ?? null }
    const filter = args.entityType ? 'AND r.entity_type = $entityType' : ''
    const allowed = new Set(['name', 'entityType', 'eventType', 'priority', 'enabled', 'conditionLogic', 'entity_type', 'event_type', 'condition_logic'])
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 'r') : ''
    const order = resolveSort('r', args.sortField, args.sortDirection, { name: 'r.name', entityType: 'r.entity_type', priority: 'r.priority', enabled: 'r.enabled' }, 'priority')
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (r:BusinessRule {tenant_id: $tenantId})
      WHERE true ${filter} ${advWhere ? `AND (${advWhere})` : ''}
      RETURN properties(r) AS props
      ${order}
    `, params)
    return rows.map(r => mapRule(r.props))
  })
}

async function createBusinessRule(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()
  const entityType     = assertEnum('entityType', input['entityType'], AUTOMATION_ENTITY_TYPES)
  const eventType      = assertEnum('eventType', input['eventType'], RULE_EVENT_TYPES)
  const conditionLogic = assertEnum('conditionLogic', input['conditionLogic'] ?? 'and', CONDITION_LOGICS)
  const conditions     = assertConditionsJson(input['conditions'])
  const actions        = assertActionsJson(input['actions'])
  return withSession(async (session) => {
    await assertStepTargets(session, ctx.tenantId, entityType, { actions, conditions })
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (r:BusinessRule {
        id: $id, tenant_id: $tenantId,
        name: $name, description: $description,
        entity_type: $entityType, event_type: $eventType,
        condition_logic: $conditionLogic, conditions: $conditions,
        actions: $actions, priority: $priority,
        stop_on_match: $stopOnMatch, enabled: $enabled,
        created_at: $now, updated_at: $now
      })
      RETURN properties(r) AS props
    `, {
      id, tenantId: ctx.tenantId,
      name: input['name'], description: input['description'] ?? null,
      entityType, eventType,
      conditionLogic,
      conditions, actions,
      priority: input['priority'] ?? 100, stopOnMatch: input['stopOnMatch'] ?? false,
      enabled: input['enabled'] ?? true, now,
    })
    invalidateRulesCache(ctx.tenantId)
    return mapRule(rows[0]!.props)
  }, true)
}

async function updateBusinessRule(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  const sets: string[] = ['r.updated_at = $now']
  const params: Props = { id: args.id, tenantId: ctx.tenantId, now: new Date().toISOString() }
  const fieldMap: Record<string, string> = {
    name: 'name', description: 'description', eventType: 'event_type',
    conditionLogic: 'condition_logic', conditions: 'conditions', actions: 'actions',
    priority: 'priority', stopOnMatch: 'stop_on_match', enabled: 'enabled',
  }
  const validators: Record<string, (v: unknown) => unknown> = {
    eventType:      (v) => assertEnum('eventType', v, RULE_EVENT_TYPES),
    conditionLogic: (v) => assertEnum('conditionLogic', v, CONDITION_LOGICS),
    conditions:     assertConditionsJson,
    actions:        assertActionsJson,
  }
  for (const [gql, neo] of Object.entries(fieldMap)) {
    if (args.input[gql] !== undefined) {
      sets.push(`r.${neo} = $${gql}`)
      params[gql] = validators[gql] ? validators[gql](args.input[gql]) : args.input[gql]
    }
  }
  return withSession(async (session) => {
    if (args.input['actions'] !== undefined || args.input['conditions'] !== undefined) {
      const entityType = await entityTypeOf(session, 'BusinessRule', args.id, ctx.tenantId)
      await assertStepTargets(session, ctx.tenantId, entityType, {
        actions:    params['actions']    as string | null | undefined,
        conditions: params['conditions'] as string | null | undefined,
      })
    }
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (r:BusinessRule {id: $id, tenant_id: $tenantId})
      SET ${sets.join(', ')}
      RETURN properties(r) AS props
    `, params)
    invalidateRulesCache(ctx.tenantId)
    return mapRule(rows[0]!.props)
  }, true)
}

async function deleteBusinessRule(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  await withSession(async (session) => {
    await runQuery(session, `MATCH (r:BusinessRule {id: $id, tenant_id: $tenantId}) DETACH DELETE r`, { id: args.id, tenantId: ctx.tenantId })
  }, true)
  invalidateRulesCache(ctx.tenantId)
  return true
}

async function reorderBusinessRules(_: unknown, args: { ruleIds: string[] }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    for (let i = 0; i < args.ruleIds.length; i++) {
      await runQuery(session, `
        MATCH (r:BusinessRule {id: $id, tenant_id: $tenantId})
        SET r.priority = $priority, r.updated_at = $now
      `, { id: args.ruleIds[i], tenantId: ctx.tenantId, priority: i + 1, now: new Date().toISOString() })
    }
    invalidateRulesCache(ctx.tenantId)
    return businessRules(null, {}, ctx)
  }, true)
}

// ── SLA Policies ─────────────────────────────────────────────────────────────

/**
 * La policy che il motore SLA sceglierebbe per un ticket con questi valori, o
 * null. Lo STESSO selettore del motore (`selectSLAForEntity`): una copia della
 * regola qui potrebbe dire «coperto» a un ticket che poi nasce senza SLA.
 */
async function slaCoverage(
  _: unknown,
  args: { entityType: string; priority: string; category?: string | null; teamId?: string | null },
  ctx: GraphQLContext,
) {
  const entityType = assertEnum('entityType', args.entityType, AUTOMATION_ENTITY_TYPES)
  if (args.priority.trim() === '') {
    throw new ValidationError('priority is required to find the SLA policy', { key: 'errors.sla.priorityRequired' })
  }
  const policy = await selectSLAForEntity(ctx.tenantId, entityType, args.priority, args.category ?? null, args.teamId ?? null)
  return policy ? { policyId: policy.id, policyName: policy.name } : null
}

async function slaPolicies(_: unknown, args: { entityType?: string; filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const params: Props = { tenantId: ctx.tenantId, entityType: args.entityType ?? null }
    const filter = args.entityType ? 'AND p.entity_type = $entityType' : ''
    const allowed = new Set(['name', 'entityType', 'priority', 'category', 'enabled', 'entity_type', 'response_minutes', 'resolve_minutes'])
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 'p') : ''
    const order = resolveSort('p', args.sortField, args.sortDirection, { entityType: 'p.entity_type', priority: 'p.priority', category: 'p.category', responseMinutes: 'p.response_minutes', resolveMinutes: 'p.resolve_minutes', name: 'p.name' }, 'entity_type')
    const rows = await runQuery<{ props: Props; teamName: string | null }>(session, `
      MATCH (p:SLAPolicyNode {tenant_id: $tenantId})
      WHERE true ${filter} ${advWhere ? `AND (${advWhere})` : ''}
      OPTIONAL MATCH (t:Team {id: p.team_id, tenant_id: $tenantId})
      RETURN properties(p) AS props, t.name AS teamName
      ${order}
    `, params)
    return rows.map(r => mapSLAPolicy(r.props, r.teamName))
  })
}

/**
 * Una policy SLA si scrive solo se il motore la può applicare: per un tipo che
 * ha uno SLA, e con la categoria solo dove il ticket ne ha una. Prima si
 * potevano salvare policy per le change e policy «Problem, categoria network»:
 * accettate, mostrate, mai applicate.
 */
function assertSLAPolicyScope(entityType: string, category: unknown): void {
  if (!(SLA_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new ValidationError(
      `SLA policies apply to ${SLA_ENTITY_TYPES.join(', ')}: "${entityType}" has no SLA`,
      { key: 'errors.sla.entityTypeWithoutSla', params: { type: entityType, allowed: SLA_ENTITY_TYPES.join(', ') } },
    )
  }
  if (category != null && category !== '' && !(SLA_CATEGORY_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new ValidationError(
      `A ${entityType} has no category: an SLA policy for it cannot depend on one`,
      { key: 'errors.sla.categoryNotApplicable', params: { type: entityType } },
    )
  }
}

async function createSLAPolicy(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()
  assertSLAPolicyScope(String(input['entityType'] ?? ''), input['category'])
  // Senza fuso scelto vale quello del cliente, non un fuso scritto nel codice.
  const timezone = typeof input['timezone'] === 'string' && input['timezone'].trim() !== ''
    ? input['timezone'].trim()
    : await getTenantTimezone(ctx.tenantId)
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (p:SLAPolicyNode {
        id: $id, tenant_id: $tenantId,
        name: $name, entity_type: $entityType,
        priority: $priority, category: $category, team_id: $teamId,
        timezone: $timezone,
        response_minutes: $responseMinutes, resolve_minutes: $resolveMinutes,
        business_hours: $businessHours, enabled: true,
        created_at: $now, updated_at: $now
      })
      RETURN properties(p) AS props
    `, {
      id, tenantId: ctx.tenantId,
      name: input['name'], entityType: input['entityType'],
      priority: input['priority'] ?? null, category: input['category'] ?? null,
      teamId: input['teamId'] ?? null, timezone,
      responseMinutes: input['responseMinutes'], resolveMinutes: input['resolveMinutes'],
      businessHours: input['businessHours'] ?? false, now,
    })
    return mapSLAPolicy(rows[0]!.props)
  }, true)
}

async function updateSLAPolicy(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  if (args.input['category'] != null && args.input['category'] !== '') {
    const current = await withSession((session) => runQuery<{ entityType: string }>(session,
      'MATCH (p:SLAPolicyNode {id: $id, tenant_id: $tenantId}) RETURN p.entity_type AS entityType',
      { id: args.id, tenantId: ctx.tenantId }))
    if (current[0]) assertSLAPolicyScope(current[0].entityType, args.input['category'])
  }
  const sets: string[] = ['p.updated_at = $now']
  const params: Props = { id: args.id, tenantId: ctx.tenantId, now: new Date().toISOString() }
  const fieldMap: Record<string, string> = {
    name: 'name', priority: 'priority', category: 'category', teamId: 'team_id',
    timezone: 'timezone', responseMinutes: 'response_minutes', resolveMinutes: 'resolve_minutes',
    businessHours: 'business_hours', enabled: 'enabled',
  }
  for (const [gql, neo] of Object.entries(fieldMap)) {
    if (args.input[gql] !== undefined) {
      sets.push(`p.${neo} = $${gql}`)
      params[gql] = args.input[gql]
    }
  }
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (p:SLAPolicyNode {id: $id, tenant_id: $tenantId})
      SET ${sets.join(', ')}
      RETURN properties(p) AS props
    `, params)
    return mapSLAPolicy(rows[0]!.props)
  }, true)
}

async function deleteSLAPolicy(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  await withSession(async (session) => {
    await runQuery(session, `MATCH (p:SLAPolicyNode {id: $id, tenant_id: $tenantId}) DETACH DELETE p`, { id: args.id, tenantId: ctx.tenantId })
  }, true)
  return true
}

// ── Export ────────────────────────────────────────────────────────────────────

export const automationResolvers = {
  Query: {
    autoTriggers,
    businessRules,
    slaPolicies,
    slaCoverage,
  },
  Mutation: {
    createAutoTrigger,
    updateAutoTrigger,
    deleteAutoTrigger,
    createBusinessRule,
    updateBusinessRule,
    deleteBusinessRule,
    reorderBusinessRules,
    createSLAPolicy,
    updateSLAPolicy,
    deleteSLAPolicy,
  },
}
