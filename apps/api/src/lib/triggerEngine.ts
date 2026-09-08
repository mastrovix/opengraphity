/**
 * AutoTrigger engine — facade over the shared automation engine.
 * Triggers are simpler than business rules: no AND/OR logic toggle (always AND),
 * no priority ordering, no stop_on_match; they add timers and execution counters.
 */
import { runQuery } from '@opengraphity/neo4j'
import { logger as appLogger } from './logger.js'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import { getQueue } from './bullmq.js'
import { createAutomationCache, evaluateRules } from './automationEngine.js'

const WORKFLOW_JOBS_QUEUE = 'workflow-jobs'

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

const cache = createAutomationCache<TriggerRecord>('trigger')

async function loadTriggers(tenantId: string, entityType: string, eventType: string): Promise<TriggerRecord[]> {
  return cache.get(tenantId, entityType, eventType, () => withSession(async (session) => {
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
  }))
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

  const outcomes = await evaluateRules({
    kind: 'trigger',
    tenantId, entityType, entity, userId,
    records: triggers.map((t) => ({
      id: t.id, name: t.name, conditions: t.conditions, actions: t.actions,
      conditionLogic: 'and', stopOnMatch: false,
    })),
    // Update execution count
    afterExecute: async (record) => {
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (t:AutoTrigger {id: $id, tenant_id: $tenantId})
          SET t.execution_count = coalesce(t.execution_count, 0) + 1,
              t.last_executed_at = $now
        `, { id: record.id, tenantId, now: new Date().toISOString() })
      }, true)
    },
  })

  return outcomes.map((o) => ({
    triggerId:   o.id,
    triggerName: o.name,
    fired:       o.matched,
    actionsRun:  o.actionsRun,
    ...(o.error ? { error: o.error } : {}),
  }))
}

/**
 * Schedules timer triggers as BullMQ delayed jobs.
 * Called after entity creation to set up "on_timer" triggers.
 *
 * Errors propagate (C-15): the caller decides whether a timer that could not
 * be scheduled fails the creation. Swallowing it here produced an entity that
 * looked healthy while its on_timer automations would never run.
 */
export async function scheduleTimerTriggers(
  tenantId:   string,
  entityType: string,
  entityId:   string,
): Promise<void> {
  const triggers = await loadTriggers(tenantId, entityType, 'on_timer')
  if (triggers.length === 0) return

  const queue = getQueue(WORKFLOW_JOBS_QUEUE)
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
}

/** Invalidate the trigger cache for a tenant. */
export function invalidateTriggerCache(tenantId: string): void {
  cache.invalidate(tenantId)
}
