/**
 * Business Rules engine — facade over the shared automation engine: rules are
 * ordered by priority (Cypher), support AND/OR condition logic and stop_on_match.
 */
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import { createAutomationCache, evaluateRules } from './automationEngine.js'

type RuleEventType = 'on_create' | 'on_update' | 'on_transition'

interface RuleRecord {
  id:              string
  name:            string
  description:     string | null
  entity_type:     string
  event_type:      RuleEventType
  condition_logic: 'and' | 'or'
  conditions:      string | null
  actions:         string | null
  priority:        number
  stop_on_match:   boolean
}

const cache = createAutomationCache<RuleRecord>('br')

async function loadRules(tenantId: string, entityType: string, eventType: string): Promise<RuleRecord[]> {
  return cache.get(tenantId, entityType, eventType, () => withSession(async (session) => {
    const rows = await runQuery<Record<string, unknown>>(session, `
      MATCH (r:BusinessRule {tenant_id: $tenantId, entity_type: $entityType, event_type: $eventType, enabled: true})
      RETURN r.id AS id, r.name AS name, r.description AS description,
             r.entity_type AS entity_type, r.event_type AS event_type,
             r.condition_logic AS condition_logic, r.conditions AS conditions,
             r.actions AS actions, r.priority AS priority, r.stop_on_match AS stop_on_match
      ORDER BY r.priority ASC
    `, { tenantId, entityType, eventType })
    return rows.map(r => ({
      id:              r['id']              as string,
      name:            r['name']            as string,
      description:     r['description']     as string | null,
      entity_type:     r['entity_type']     as string,
      event_type:      r['event_type']       as RuleEventType,
      condition_logic: (r['condition_logic'] as 'and' | 'or') ?? 'and',
      conditions:      r['conditions']       as string | null,
      actions:         r['actions']          as string | null,
      priority:        Number(r['priority'] ?? 100),
      stop_on_match:   (r['stop_on_match']  as boolean) ?? false,
    }))
  }))
}

// ── Main evaluation function ─────────────────────────────────────────────────

export interface RuleResult {
  ruleId:   string
  ruleName: string
  matched:  boolean
  actionsRun: number
  stopped:  boolean
  error?:   string
}

/**
 * Evaluates all enabled BusinessRules for the given entity, ordered by priority.
 * Supports AND/OR condition logic and stop_on_match.
 */
export async function evaluateBusinessRules(
  tenantId:   string,
  entityType: string,
  eventType:  RuleEventType,
  entity:     Record<string, unknown>,
  userId:     string,
  _previousEntity?: Record<string, unknown>,
): Promise<RuleResult[]> {
  const rules = await loadRules(tenantId, entityType, eventType)
  if (rules.length === 0) return []

  const outcomes = await evaluateRules({
    kind: 'rule',
    tenantId, entityType, entity, userId,
    records: rules.map((r) => ({
      id: r.id, name: r.name, conditions: r.conditions, actions: r.actions,
      conditionLogic: r.condition_logic, stopOnMatch: r.stop_on_match,
    })),
  })

  return outcomes.map((o) => ({
    ruleId:     o.id,
    ruleName:   o.name,
    matched:    o.matched,
    actionsRun: o.actionsRun,
    stopped:    o.stopped,
    ...(o.error ? { error: o.error } : {}),
  }))
}

/** Invalidate the rules cache for a tenant. */
export function invalidateRulesCache(tenantId: string): void {
  cache.invalidate(tenantId)
}
