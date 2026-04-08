import { v4 as uuidv4 } from 'uuid'
import { withSession } from './ci-utils.js'
import { runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { invalidateTriggerCache } from '../../lib/triggerEngine.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { invalidateRulesCache } from '../../lib/rulesEngine.js'

type Props = Record<string, unknown>

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
  return withSession(async (session) => {
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
      name: input['name'], entityType: input['entityType'], eventType: input['eventType'],
      conditions: input['conditions'] ?? null,
      timerDelayMinutes: input['timerDelayMinutes'] ?? null,
      actions: input['actions'] ?? null,
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
  for (const [gql, neo] of Object.entries(fieldMap)) {
    if (args.input[gql] !== undefined) {
      sets.push(`t.${neo} = $${gql}`)
      params[gql] = args.input[gql]
    }
  }
  return withSession(async (session) => {
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
  return withSession(async (session) => {
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
      entityType: input['entityType'], eventType: input['eventType'],
      conditionLogic: input['conditionLogic'] ?? 'and',
      conditions: input['conditions'] ?? null, actions: input['actions'] ?? null,
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
  for (const [gql, neo] of Object.entries(fieldMap)) {
    if (args.input[gql] !== undefined) {
      sets.push(`r.${neo} = $${gql}`)
      params[gql] = args.input[gql]
    }
  }
  return withSession(async (session) => {
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

async function createSLAPolicy(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()
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
      teamId: input['teamId'] ?? null, timezone: input['timezone'] ?? 'Europe/Rome',
      responseMinutes: input['responseMinutes'], resolveMinutes: input['resolveMinutes'],
      businessHours: input['businessHours'] ?? false, now,
    })
    return mapSLAPolicy(rows[0]!.props)
  }, true)
}

async function updateSLAPolicy(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
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
