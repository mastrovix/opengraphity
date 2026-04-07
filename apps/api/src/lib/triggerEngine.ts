/**
 * AutoTrigger engine — evaluates and executes automatic triggers.
 * Triggers are simpler than business rules: no AND/OR logic toggle (always AND),
 * no priority ordering, no stop_on_match.
 */
import { runQuery } from '@opengraphity/neo4j'
import { logger as appLogger } from './logger.js'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import { evaluateConditions, parseConditions } from './conditionEvaluator.js'
import { executeActions, parseActions, type ActionExecutionContext } from './actionExecutor.js'
import { audit } from './audit.js'

const log = appLogger.child({ module: 'trigger-engine' })

type TriggerEventType = 'on_create' | 'on_update' | 'on_timer' | 'on_sla_breach' | 'on_field_change'

interface TriggerRecord {
  id:                 string
  name:               string
  entity_type:        string
  event_type:         TriggerEventType
  conditions:         string | null
  timer_delay_minutes: number | null
  actions:            string | null
}

// ── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  triggers: TriggerRecord[]
  loadedAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

function cacheKey(tenantId: string, entityType: string, eventType: string): string {
  return `${tenantId}:${entityType}:${eventType}`
}

async function loadTriggers(
  tenantId:   string,
  entityType: string,
  eventType:  string,
): Promise<TriggerRecord[]> {
  const key = cacheKey(tenantId, entityType, eventType)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.triggers

  const triggers = await withSession(async (session) => {
    const rows = await runQuery<Record<string, unknown>>(session, `
      MATCH (t:AutoTrigger {tenant_id: $tenantId, entity_type: $entityType, event_type: $eventType, enabled: true})
      RETURN t.id AS id, t.name AS name, t.entity_type AS entity_type, t.event_type AS event_type,
             t.conditions AS conditions, t.timer_delay_minutes AS timer_delay_minutes, t.actions AS actions
      ORDER BY t.name
    `, { tenantId, entityType, eventType })
    return rows.map(r => ({
      id:                  r['id']                  as string,
      name:                r['name']                as string,
      entity_type:         r['entity_type']         as string,
      event_type:          r['event_type']           as TriggerEventType,
      conditions:          r['conditions']           as string | null,
      timer_delay_minutes: r['timer_delay_minutes'] != null ? Number(r['timer_delay_minutes']) : null,
      actions:             r['actions']              as string | null,
    }))
  })

  cache.set(key, { triggers, loadedAt: Date.now() })
  return triggers
}

// ── Main evaluation function ─────────────────────────────────────────────────

export interface TriggerResult {
  triggerId:   string
  triggerName: string
  fired:       boolean
  actionsRun:  number
  error?:      string
}

/**
 * Evaluates all enabled AutoTriggers for the given entity type and event type.
 * For each trigger whose conditions are met, executes its actions.
 */
export async function evaluateTriggers(
  tenantId:   string,
  entityType: string,
  eventType:  TriggerEventType,
  entity:     Record<string, unknown>,
  userId:     string,
  _previousEntity?: Record<string, unknown>,
): Promise<TriggerResult[]> {
  const triggers = await loadTriggers(tenantId, entityType, eventType)
  if (triggers.length === 0) return []

  const results: TriggerResult[] = []

  for (const trigger of triggers) {
    const conditions = parseConditions(trigger.conditions)
    const matched = evaluateConditions(conditions, entity)

    if (!matched) {
      results.push({ triggerId: trigger.id, triggerName: trigger.name, fired: false, actionsRun: 0 })
      continue
    }

    const actions = parseActions(trigger.actions)
    const execCtx: ActionExecutionContext = {
      tenantId,
      userId,
      entityId:   entity['id'] as string,
      entityType,
      entity,
      source:     'trigger',
      sourceName: trigger.name,
    }

    try {
      const actionResults = await executeActions(actions, execCtx)

      // Update execution count
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (t:AutoTrigger {id: $id, tenant_id: $tenantId})
          SET t.execution_count = coalesce(t.execution_count, 0) + 1,
              t.last_executed_at = $now
        `, { id: trigger.id, tenantId, now: new Date().toISOString() })
      }, true)

      void audit(
        { tenantId, userId, userEmail: 'system', role: 'system' } as never,
        'trigger.executed', 'AutoTrigger', trigger.id,
        { triggerName: trigger.name, entityId: entity['id'], actionsRun: actionResults.length },
      )

      results.push({
        triggerId: trigger.id, triggerName: trigger.name, fired: true,
        actionsRun: actionResults.filter(r => r.success).length,
      })

      log.info({ triggerId: trigger.id, name: trigger.name, entityId: entity['id'], actionsRun: actionResults.length }, 'Trigger fired')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      results.push({ triggerId: trigger.id, triggerName: trigger.name, fired: true, actionsRun: 0, error: errorMsg })
      log.error({ triggerId: trigger.id, err }, 'Trigger execution failed')
    }
  }

  return results
}

/**
 * Schedules timer triggers as BullMQ delayed jobs.
 * Called after entity creation to set up "on_timer" triggers.
 */
export async function scheduleTimerTriggers(
  tenantId:   string,
  entityType: string,
  entityId:   string,
): Promise<void> {
  const triggers = await loadTriggers(tenantId, entityType, 'on_timer')
  if (triggers.length === 0) return

  try {
    const { Queue } = await import('bullmq')
    const { getRedisOptions } = await import('@opengraphity/events')
    const queue = new Queue('workflow-jobs', { connection: getRedisOptions() })

    for (const trigger of triggers) {
      if (!trigger.timer_delay_minutes || trigger.timer_delay_minutes <= 0) continue
      await queue.add('trigger_timer', {
        triggerId: trigger.id,
        tenantId,
        entityType,
        entityId,
      }, {
        delay:              trigger.timer_delay_minutes * 60 * 1000,
        jobId:              `trigger:${trigger.id}:${entityId}`,
        removeOnComplete:   true,
      })
      log.info({ triggerId: trigger.id, entityId, delayMinutes: trigger.timer_delay_minutes }, 'Timer trigger scheduled')
    }

    await queue.close()
  } catch (err) {
    log.error({ err }, 'Failed to schedule timer triggers')
  }
}

/** Invalidate the trigger cache for a tenant. */
export function invalidateTriggerCache(tenantId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${tenantId}:`)) cache.delete(key)
  }
}
