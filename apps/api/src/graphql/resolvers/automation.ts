import { v4 as uuidv4 } from 'uuid'
import { assertComplianceObjective, calendarChoice, calendarNameOf } from '../../lib/serviceTargets.js'
import { withSession } from './ci-utils.js'
import { runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { invalidateTriggerCache } from '../../lib/triggerEngine.js'
import { assertStepFieldValue, stepFieldMetas } from '../../lib/stepFieldWrites.js'
import { formFieldAutomationMetas } from '../../lib/catalogForm.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { invalidateRulesCache } from '../../lib/rulesEngine.js'
import { parseConditions, usesChangedOperator, type ConditionOperator } from '../../lib/conditionEvaluator.js'
import { parseActions, type ActionType } from '../../lib/actionExecutor.js'
import { ValidationError } from '../../lib/errors.js'
import { getWorkflowSteps } from '../../lib/workflowHelpers.js'
import type { Session } from 'neo4j-driver'
import { selectSLAForEntity, assertRuleSLAMinutes } from '@opengraphity/sla'
import { assertTimeZone } from '../../lib/tenantTimezone.js'
import {
  SLA_ENTITY_TYPES, SLA_CATEGORY_ENTITY_TYPES,
  AUTOMATION_ENTITY_TYPES, TRIGGER_EVENT_TYPES, RULE_EVENT_TYPES, AUTOMATION_EVENT_ENTITIES, automationEventSupported,
  type AutomationEventType, isNotificationTarget, AUTOMATION_NOTIFICATION_CHANNELS, DEFAULT_SLA_WARNING_MINUTES,
} from '@opengraphity/types'
import { assertRolesExist, roleKeysInActions } from '../../lib/roles.js'

type Props = Record<string, unknown>

// ── Write-time validation (C-16) ─────────────────────────────────────────────
// Conditions/actions are stored as JSON strings and parsed by the SAME parsers
// the runtime uses. Before, corrupt JSON or an unknown event type was accepted
// and the rule failed only at runtime (log line only): the rule looked enabled
// while never firing.

export { AUTOMATION_ENTITY_TYPES, TRIGGER_EVENT_TYPES, RULE_EVENT_TYPES }
export const CONDITION_LOGICS         = ['and', 'or'] as const
const CONDITION_OPERATORS: readonly ConditionOperator[] = ['equals', 'not_equals', 'is_null', 'is_not_null', 'greater_than', 'less_than', 'contains', 'changed']

/** Gli eventi in cui «è cambiato» ha senso: su una creazione o una transizione non scatterebbe mai (V-19). */
const CHANGED_OPERATOR_EVENTS: readonly string[] = ['on_update', 'on_field_change']

export function assertChangedOperatorEvent(conditions: string | null | undefined, eventType: string): void {
  if (!conditions) return
  if (CHANGED_OPERATOR_EVENTS.includes(eventType)) return
  if (!usesChangedOperator(parseConditions(conditions))) return
  throw new ValidationError(
    `The condition «is changed» only works when the ticket is updated (event on_update or on_field_change), not on ${eventType}: the rule would never fire.`,
    { key: 'errors.automation.changedNeedsUpdate', params: { event: eventType } },
  )
}
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
    if (a.type === 'set_sla') {
      try {
        assertRuleSLAMinutes(a.params?.['response_minutes'], a.params?.['resolve_minutes'])
      } catch (err) {
        throw new ValidationError(`Invalid actions: item ${i} — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (a.type === 'create_notification') {
      const target = a.params?.['target'] ?? 'all'
      const channel = a.params?.['channel'] ?? 'in_app'
      if (!isNotificationTarget(target)) throw new ValidationError(`Invalid actions: item ${i} (create_notification) has unknown recipient ${JSON.stringify(target)}`)
      if (typeof channel !== 'string' || !AUTOMATION_NOTIFICATION_CHANNELS.includes(channel)) {
        throw new ValidationError(`Invalid actions: item ${i} (create_notification) channel must be one of: ${AUTOMATION_NOTIFICATION_CHANNELS.join(', ')}`)
      }
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
  // I CAMPI che l'automazione scrive (revisione totale · C-4): `set_field` e
  // `set_priority` passano dalla stessa validazione dell'azione di passo
  // `update_field` — il campo deve essere del metamodello del cliente e il
  // valore del suo vocabolario. Prima la scrittura accettava qualunque
  // proprietà non compresa in una lista di dieci nomi, e il rifiuto arrivava
  // (se arrivava) solo a runtime, in un log.
  await assertAutomationFieldWrites(session, tenantId, entityType, opts.actions)

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

/**
 * I campi scritti da `set_field` / `set_priority`, validati contro il
 * metamodello e i vocabolari del cliente (revisione totale · C-4). Un valore
 * con un segnaposto `{campo}` si risolve a runtime e lì viene validato di
 * nuovo, come per le azioni di passo.
 */
async function assertAutomationFieldWrites(
  session: Session, tenantId: string, entityType: string, actions?: string | null,
): Promise<void> {
  if (actions == null || (!actions.includes('set_field') && !actions.includes('set_priority'))) return
  const parsed = parseActions(actions)
  const writes = parsed.map((a, i) => ({ a, i })).filter(({ a }) => a?.type === 'set_field' || a?.type === 'set_priority')
  if (writes.length === 0) return
  /*
   * IL METAMODELLO **PIÙ** I CAMPI DEI MODULI (ondata 8).
   *
   * Un'azione `set_field` su una richiesta può scrivere una risposta al modulo:
   * l'esecutore la manda a `writeFormAnswer`, che riapplica le
   * regole del modulo (revisione con cui è stata compilata, condizioni,
   * vocabolario, validationScript). Senza questi campi la validazione rifiutava
   * una regola che poi avrebbe funzionato — «modello_richiesto non è un campo di
   * questo tipo di ticket», su un campo che la tendina offriva (visto dal vivo
   * su c-test). Il metamodello VINCE sui nomi uguali: è quello che il ticket
   * scrive davvero.
   */
  const metas = new Map([
    ...await formFieldAutomationMetas(session, tenantId, entityType),
    ...await stepFieldMetas(session, tenantId, entityType),
  ])
  for (const { a, i } of writes) {
    const field = a.type === 'set_priority' ? 'priority' : String(a.params?.['field'] ?? '')
    const value = a.type === 'set_priority' ? (a.params?.['priority'] ?? a.params?.['value']) : a.params?.['value']
    if (!field) {
      throw new ValidationError(`Invalid actions: item ${i} (${a.type}) needs the field name.`, { key: 'errors.automation.fieldRequired', params: { item: i, type: a.type } })
    }
    // La priorità di un incident vive su `severity`: è la stessa coppia che
    // `writeTicketField` conosce, e il metamodello la dichiara così.
    const metaField = field === 'priority' && entityType === 'incident' && !metas.has('priority') ? 'severity' : field
    assertStepFieldValue(metas, entityType, metaField, value, `Invalid actions: item ${i} (${a.type})`, { allowTemplate: true })
  }
}

/**
 * La combinazione evento × ticket deve essere una che gira davvero
 * (`AUTOMATION_EVENT_ENTITIES`, revisione del 14 set 2026 · AU-1): prima le
 * pagine offrivano combinazioni che nessun codice eseguiva, e la regola restava
 * «attiva» per sempre senza mai partire.
 */
export function assertEventSupported(eventType: string, entityType: string): void {
  if (automationEventSupported(eventType, entityType)) return
  const supported = AUTOMATION_EVENT_ENTITIES[eventType as AutomationEventType] ?? []
  throw new ValidationError(
    `The event "${eventType}" does not run for "${entityType}": it runs for ${supported.join(', ') || 'no ticket type'}.`,
    { key: 'errors.automation.eventNotSupported', params: { event: eventType, entityType, supported: supported.join(', ') } },
  )
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

/** Evento e condizioni salvati: servono a controllare «è cambiato» quando l'aggiornamento ne cambia uno solo. */
async function storedEventAndConditions(session: Session, label: 'AutoTrigger' | 'BusinessRule', id: string, tenantId: string): Promise<{ eventType: string; conditions: string | null }> {
  const rows = await runQuery<{ eventType: string; conditions: string | null }>(session, `
    MATCH (n:${label} {id: $id, tenant_id: $tenantId})
    RETURN n.event_type AS eventType, n.conditions AS conditions
  `, { id, tenantId })
  const row = rows[0]
  if (!row) throw new ValidationError(`${label} ${id} not found`, { key: 'errors.notFound', params: { entity: label, id } })
  return row
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
    // null = eredita il fuso del cliente (revisione del 14 set 2026 · F7).
    timezone:        p['timezone']         ?? null,
    responseMinutes: Number(p['response_minutes'] ?? 0),
    resolveMinutes:  Number(p['resolve_minutes']  ?? 0),
    businessHours:   p['business_hours']   ?? false,
    calendarId:      (p['calendar_id']      ?? null) as string | null,
    complianceTarget:  p['compliance_target']  == null ? null : Number(p['compliance_target']),
    complianceWarning: p['compliance_warning'] == null ? null : Number(p['compliance_warning']),
    warningMinutes:  Number(p['warning_minutes']),
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
  assertEventSupported(eventType, entityType)
  assertChangedOperatorEvent(conditions, eventType)
  await assertRolesExist(ctx.tenantId, roleKeysInActions(actions))
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
  if (typeof params['actions'] === 'string') await assertRolesExist(ctx.tenantId, roleKeysInActions(params['actions']))
  return withSession(async (session) => {
    if (args.input['eventType'] !== undefined) {
      assertEventSupported(params['eventType'] as string, await entityTypeOf(session, 'AutoTrigger', args.id, ctx.tenantId))
    }
    if (args.input['eventType'] !== undefined || args.input['conditions'] !== undefined) {
      const stored = await storedEventAndConditions(session, 'AutoTrigger', args.id, ctx.tenantId)
      assertChangedOperatorEvent(
        args.input['conditions'] !== undefined ? params['conditions'] as string | null : stored.conditions,
        args.input['eventType'] !== undefined ? params['eventType'] as string : stored.eventType,
      )
    }
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
  assertEventSupported(eventType, entityType)
  const conditionLogic = assertEnum('conditionLogic', input['conditionLogic'] ?? 'and', CONDITION_LOGICS)
  const conditions     = assertConditionsJson(input['conditions'])
  assertChangedOperatorEvent(conditions, eventType)
  const actions        = assertActionsJson(input['actions'])
  await assertRolesExist(ctx.tenantId, roleKeysInActions(actions))
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
  if (typeof params['actions'] === 'string') await assertRolesExist(ctx.tenantId, roleKeysInActions(params['actions']))
  return withSession(async (session) => {
    if (args.input['eventType'] !== undefined) {
      assertEventSupported(params['eventType'] as string, await entityTypeOf(session, 'BusinessRule', args.id, ctx.tenantId))
    }
    if (args.input['eventType'] !== undefined || args.input['conditions'] !== undefined) {
      const stored = await storedEventAndConditions(session, 'BusinessRule', args.id, ctx.tenantId)
      assertChangedOperatorEvent(
        args.input['conditions'] !== undefined ? params['conditions'] as string | null : stored.conditions,
        args.input['eventType'] !== undefined ? params['eventType'] as string : stored.eventType,
      )
    }
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

/** Il preavviso deve cadere dentro il tempo di risoluzione, altrimenti l'avviso partirebbe già scaduto. */
function assertWarningMinutes(warning: unknown, resolve: unknown): number {
  const w = Number(warning)
  if (!Number.isInteger(w) || w <= 0) {
    throw new ValidationError(`warningMinutes must be a positive whole number of minutes. Got: ${JSON.stringify(warning)}`, { key: 'errors.sla.warningMinutes' })
  }
  if (resolve != null && w >= Number(resolve)) {
    throw new ValidationError(`The SLA warning (${w} min before the deadline) must be shorter than the resolution time (${String(resolve)} min)`, { key: 'errors.sla.warningLongerThanResolve', params: { warning: w, resolve: Number(resolve) } })
  }
  return w
}

/**
 * Il fuso di una policy SLA: `null` quando non ne sceglie uno, e allora segue
 * quello del cliente al momento della selezione (packages/sla/src/selector.ts).
 * Prima si copiava il fuso del cliente nella policy, così cambiarlo dalla
 * pagina Organizzazione non spostava nessuna scadenza. Revisione del 14 set
 * 2026 · F7.
 */
function policyTimezone(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return assertTimeZone(typeof value === 'string' ? value.trim() : value)
}

async function createSLAPolicy(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const warningMinutes = assertWarningMinutes(input['warningMinutes'] ?? DEFAULT_SLA_WARNING_MINUTES, input['resolveMinutes'])
  const id  = uuidv4()
  const now = new Date().toISOString()
  assertSLAPolicyScope(String(input['entityType'] ?? ''), input['category'])
  const timezone = policyTimezone(input['timezone'])
  const objective = assertComplianceObjective(input['complianceTarget'], input['complianceWarning'])
  const calendar = await calendarChoice(ctx.tenantId, input['calendarId'])
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (p:SLAPolicyNode {
        id: $id, tenant_id: $tenantId,
        name: $name, entity_type: $entityType,
        priority: $priority, category: $category, team_id: $teamId,
        timezone: $timezone,
        response_minutes: $responseMinutes, resolve_minutes: $resolveMinutes,
        business_hours: $businessHours, calendar_id: $calendarId, warning_minutes: $warningMinutes, enabled: true,
        compliance_target: $complianceTarget, compliance_warning: $complianceWarning,
        created_at: $now, updated_at: $now
      })
      RETURN properties(p) AS props
    `, {
      id, tenantId: ctx.tenantId,
      name: input['name'], entityType: input['entityType'],
      priority: input['priority'] ?? null, category: input['category'] ?? null,
      teamId: input['teamId'] ?? null, timezone,
      responseMinutes: input['responseMinutes'], resolveMinutes: input['resolveMinutes'],
      businessHours: calendar.business_hours, calendarId: calendar.calendar_id, warningMinutes, now,
      complianceTarget: objective.target, complianceWarning: objective.warning,
    })
    return mapSLAPolicy(rows[0]!.props)
  }, true)
}

async function updateSLAPolicy(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  if (args.input['timezone'] !== undefined) args.input = { ...args.input, timezone: policyTimezone(args.input['timezone']) }
  if (args.input['category'] != null && args.input['category'] !== '') {
    const current = await withSession((session) => runQuery<{ entityType: string }>(session,
      'MATCH (p:SLAPolicyNode {id: $id, tenant_id: $tenantId}) RETURN p.entity_type AS entityType',
      { id: args.id, tenantId: ctx.tenantId }))
    if (current[0]) assertSLAPolicyScope(current[0].entityType, args.input['category'])
  }
  if (args.input['warningMinutes'] !== undefined || args.input['resolveMinutes'] !== undefined) {
    const current = await withSession((session) => runQuery<{ warning: unknown; resolve: unknown }>(session,
      'MATCH (p:SLAPolicyNode {id: $id, tenant_id: $tenantId}) RETURN p.warning_minutes AS warning, p.resolve_minutes AS resolve',
      { id: args.id, tenantId: ctx.tenantId }))
    if (current[0]) assertWarningMinutes(args.input['warningMinutes'] ?? current[0].warning, args.input['resolveMinutes'] ?? current[0].resolve)
  }
  const sets: string[] = ['p.updated_at = $now']
  const params: Props = { id: args.id, tenantId: ctx.tenantId, now: new Date().toISOString() }
  // Calendario: `null` esplicito = 24×7, assente = invariato (ondata 2).
  if (args.input['calendarId'] !== undefined) {
    const calendar = await calendarChoice(ctx.tenantId, args.input['calendarId'])
    sets.push('p.calendar_id = $calendarIdValue', 'p.business_hours = $businessHoursValue')
    params['calendarIdValue'] = calendar.calendar_id
    params['businessHoursValue'] = calendar.business_hours
  }
  // Obiettivo e soglia si validano sullo stato FINALE: se ne arriva uno solo, l'altro è quello salvato.
  if (args.input['complianceTarget'] !== undefined || args.input['complianceWarning'] !== undefined) {
    const current = await withSession((session) => runQuery<{ target: unknown; warning: unknown }>(session,
      'MATCH (p:SLAPolicyNode {id: $id, tenant_id: $tenantId}) RETURN p.compliance_target AS target, p.compliance_warning AS warning',
      { id: args.id, tenantId: ctx.tenantId }))
    const objective = assertComplianceObjective(args.input['complianceTarget'] ?? current[0]?.target, args.input['complianceWarning'] ?? current[0]?.warning)
    sets.push('p.compliance_target = $complianceTargetValue', 'p.compliance_warning = $complianceWarningValue')
    params['complianceTargetValue'] = objective.target
    params['complianceWarningValue'] = objective.warning
  }
  const fieldMap: Record<string, string> = {
    name: 'name', priority: 'priority', category: 'category', teamId: 'team_id',
    timezone: 'timezone', responseMinutes: 'response_minutes', resolveMinutes: 'resolve_minutes',
    warningMinutes: 'warning_minutes', enabled: 'enabled',
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

/** Il nome del calendario della policy (ondata 2): letto dal calendario vivo, così una rinomina si vede. */
async function slaPolicyCalendarName(parent: { calendarId: string | null }, _: unknown, ctx: GraphQLContext) {
  return calendarNameOf(ctx.tenantId, parent.calendarId)
}

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
  SLAPolicyNode: { calendarName: slaPolicyCalendarName },
}
