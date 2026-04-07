/**
 * Business Rules engine — evaluates rules ordered by priority with AND/OR logic
 * and stop_on_match support.
 */
import { runQuery } from '@opengraphity/neo4j'
import { logger as appLogger } from './logger.js'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import { evaluateConditions, parseConditions } from './conditionEvaluator.js'
import { executeActions, parseActions, type ActionExecutionContext } from './actionExecutor.js'
import { audit } from './audit.js'

const log = appLogger.child({ module: 'rules-engine' })

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

// ── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  rules:    RuleRecord[]
  loadedAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

function cacheKey(tenantId: string, entityType: string, eventType: string): string {
  return `br:${tenantId}:${entityType}:${eventType}`
}

async function loadRules(tenantId: string, entityType: string, eventType: string): Promise<RuleRecord[]> {
  const key = cacheKey(tenantId, entityType, eventType)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.rules

  const rules = await withSession(async (session) => {
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
  })

  cache.set(key, { rules, loadedAt: Date.now() })
  return rules
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

  const results: RuleResult[] = []

  for (const rule of rules) {
    const conditions = parseConditions(rule.conditions)
    const matched = evaluateConditions(conditions, entity, rule.condition_logic)

    if (!matched) {
      results.push({ ruleId: rule.id, ruleName: rule.name, matched: false, actionsRun: 0, stopped: false })
      continue
    }

    const actions = parseActions(rule.actions)
    const execCtx: ActionExecutionContext = {
      tenantId,
      userId,
      entityId:   entity['id'] as string,
      entityType,
      entity,
      source:     'business_rule',
      sourceName: rule.name,
    }

    try {
      const actionResults = await executeActions(actions, execCtx)

      void audit(
        { tenantId, userId, userEmail: 'system', role: 'system' } as never,
        'business_rule.executed', 'BusinessRule', rule.id,
        { ruleName: rule.name, entityId: entity['id'], actionsRun: actionResults.length },
      )

      const stopped = rule.stop_on_match
      results.push({
        ruleId: rule.id, ruleName: rule.name, matched: true,
        actionsRun: actionResults.filter(r => r.success).length,
        stopped,
      })

      log.info({ ruleId: rule.id, name: rule.name, entityId: entity['id'], actionsRun: actionResults.length, stopped }, 'Business rule fired')

      if (stopped) break
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      results.push({ ruleId: rule.id, ruleName: rule.name, matched: true, actionsRun: 0, stopped: false, error: errorMsg })
      log.error({ ruleId: rule.id, err }, 'Business rule execution failed')
    }
  }

  return results
}

/** Invalidate the rules cache for a tenant. */
export function invalidateRulesCache(tenantId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`br:${tenantId}:`)) cache.delete(key)
  }
}
