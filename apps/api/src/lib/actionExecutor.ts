/**
 * Shared action executor — used by AutoTriggers and BusinessRules.
 * Each action executes in sequence; if one fails, remaining actions are skipped.
 */
import { v4 as uuidv4 } from 'uuid'
import pino from 'pino'
import { runQuery } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { withSession } from '../graphql/resolvers/ci-utils.js'

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'action-executor' })

export type ActionType =
  | 'set_field'
  | 'assign_team'
  | 'assign_user'
  | 'transition_workflow'
  | 'create_notification'
  | 'create_comment'
  | 'set_priority'
  | 'execute_script'
  | 'call_webhook'
  | 'set_sla'

export interface Action {
  type:   ActionType
  params: Record<string, unknown>
}

export interface ActionExecutionContext {
  tenantId:   string
  userId:     string
  entityId:   string
  entityType: string
  entity:     Record<string, unknown>
  source:     'trigger' | 'business_rule'
  sourceName: string
}

export interface ActionResult {
  action: ActionType
  success: boolean
  error?: string
}

/**
 * Parses a JSON string of actions, returns empty array on failure.
 */
export function parseActions(raw: string | null | undefined): Action[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * Executes an array of actions sequentially against an entity.
 * Stops on first failure and returns results for all attempted actions.
 */
export async function executeActions(
  actions: Action[],
  ctx: ActionExecutionContext,
): Promise<ActionResult[]> {
  const results: ActionResult[] = []
  const now = new Date().toISOString()

  for (const action of actions) {
    try {
      await executeSingleAction(action, ctx, now)
      results.push({ action: action.type, success: true })
      log.info({ type: action.type, entityId: ctx.entityId, source: ctx.source, rule: ctx.sourceName }, 'Action executed')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      results.push({ action: action.type, success: false, error: errorMsg })
      log.error({ type: action.type, entityId: ctx.entityId, source: ctx.source, rule: ctx.sourceName, err }, 'Action failed — stopping execution')
      break
    }
  }

  return results
}

async function executeSingleAction(action: Action, ctx: ActionExecutionContext, now: string): Promise<void> {
  const p = action.params

  switch (action.type) {
    case 'set_field': {
      const field = String(p['field'] ?? '')
      const value = p['value']
      if (!field) throw new Error('set_field: field is required')
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (e {id: $entityId, tenant_id: $tenantId})
          SET e[$field] = $value, e.updated_at = $now
        `, { entityId: ctx.entityId, tenantId: ctx.tenantId, field, value, now })
      }, true)
      break
    }

    case 'set_priority': {
      const value = String(p['priority'] ?? p['value'] ?? '')
      if (!value) throw new Error('set_priority: priority value is required')
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (e {id: $entityId, tenant_id: $tenantId})
          SET e.priority = $value, e.updated_at = $now
        `, { entityId: ctx.entityId, tenantId: ctx.tenantId, value, now })
      }, true)
      break
    }

    case 'assign_team': {
      const teamId = String(p['team_id'] ?? '')
      if (!teamId) throw new Error('assign_team: team_id is required')
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (e {id: $entityId, tenant_id: $tenantId})
          OPTIONAL MATCH (e)-[old:ASSIGNED_TO_TEAM]->()
          DELETE old
          WITH e
          MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
          CREATE (e)-[:ASSIGNED_TO_TEAM]->(t)
          SET e.updated_at = $now
        `, { entityId: ctx.entityId, tenantId: ctx.tenantId, teamId, now })
      }, true)
      break
    }

    case 'assign_user': {
      const userId = String(p['user_id'] ?? '')
      if (!userId) throw new Error('assign_user: user_id is required')
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (e {id: $entityId, tenant_id: $tenantId})
          OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->()
          DELETE old
          WITH e
          MATCH (u:User {id: $userId, tenant_id: $tenantId})
          CREATE (e)-[:ASSIGNED_TO]->(u)
          SET e.updated_at = $now
        `, { entityId: ctx.entityId, tenantId: ctx.tenantId, userId, now })
      }, true)
      break
    }

    case 'transition_workflow': {
      const toStep = String(p['to_step'] ?? '')
      if (!toStep) throw new Error('transition_workflow: to_step is required')
      const { workflowEngine } = await import('@opengraphity/workflow')
      await withSession(async (session) => {
        const wiRes = await session.executeRead(tx => tx.run(`
          MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          RETURN wi.id AS instanceId
        `, { entityId: ctx.entityId, tenantId: ctx.tenantId }))
        if (wiRes.records.length === 0) throw new Error('No workflow instance found')
        const instanceId = wiRes.records[0].get('instanceId') as string
        await workflowEngine.transition(session, {
          instanceId, toStepName: toStep,
          triggeredBy: 'system', triggerType: 'automatic',
          notes: `Auto: ${ctx.sourceName}`,
        }, { userId: ctx.userId, entityData: ctx.entity })
      }, true)
      break
    }

    case 'create_notification': {
      const message = String(p['message'] ?? '')
      const channel = String(p['channel'] ?? 'in_app')
      const event: DomainEvent<{ entity_id: string; entity_type: string; message: string; channel: string }> = {
        id:             uuidv4(),
        type:           'automation.notification',
        tenant_id:      ctx.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       ctx.userId,
        payload: { entity_id: ctx.entityId, entity_type: ctx.entityType, message, channel },
      }
      await publish(event)
      break
    }

    case 'create_comment': {
      const text = String(p['text'] ?? p['message'] ?? '')
      if (!text) throw new Error('create_comment: text is required')
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (e {id: $entityId, tenant_id: $tenantId})
          CREATE (c:Comment {
            id:         randomUUID(),
            tenant_id:  $tenantId,
            text:       $text,
            author_id:  'system',
            created_at: $now,
            updated_at: $now
          })
          CREATE (e)-[:HAS_COMMENT]->(c)
        `, { entityId: ctx.entityId, tenantId: ctx.tenantId, text, now })
      }, true)
      break
    }

    case 'execute_script': {
      const code = String(p['code'] ?? '')
      if (!code) throw new Error('execute_script: code is required')
      const { runScript } = await import('@opengraphity/scripting')
      const result = await runScript(
        { id: 'inline', tenant_id: ctx.tenantId, name: ctx.sourceName, trigger: 'automation' as never, code, enabled: true, created_at: now, updated_at: now },
        { entity: ctx.entity, tenantId: ctx.tenantId, userId: ctx.userId },
      )
      if (!result.success) throw new Error(`Script failed: ${result.error ?? 'unknown'}`)
      break
    }

    case 'call_webhook': {
      const url     = String(p['url'] ?? '')
      const method  = String(p['method'] ?? 'POST')
      const headers = (p['headers'] ?? {}) as Record<string, string>
      if (!url) throw new Error('call_webhook: url is required')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const payload = JSON.stringify({ entity: ctx.entity, entityType: ctx.entityType, source: ctx.source, rule: ctx.sourceName })
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body:    method !== 'GET' ? payload : undefined,
          signal:  controller.signal,
        })
        if (!res.ok) throw new Error(`Webhook returned ${res.status}`)
      } finally {
        clearTimeout(timer)
      }
      break
    }

    case 'set_sla': {
      const responseMins = Number(p['response_minutes'] ?? 0)
      const resolveMins  = Number(p['resolve_minutes'] ?? 0)
      if (responseMins <= 0 && resolveMins <= 0) break
      const { calculateDeadline } = await import('@opengraphity/sla')
      const startedAt         = new Date()
      const responseDeadline  = calculateDeadline(startedAt, responseMins, false, 'Europe/Rome')
      const resolveDeadline   = calculateDeadline(startedAt, resolveMins,  false, 'Europe/Rome')
      await withSession(async (session) => {
        await runQuery(session, `
          MATCH (e {id: $entityId, tenant_id: $tenantId})
          OPTIONAL MATCH (e)-[r:HAS_SLA]->(old:SLAStatus)
          DELETE r, old
          WITH e
          CREATE (s:SLAStatus {
            id:                    randomUUID(),
            tenant_id:             $tenantId,
            entity_id:             $entityId,
            entity_type:           $entityType,
            started_at:            $startedAt,
            response_deadline:     $responseDeadline,
            resolve_deadline:      $resolveDeadline,
            response_met:          false,
            resolve_met:           false,
            breached:              false,
            tier_severity:         'custom',
            tier_response_minutes: $responseMins,
            tier_resolve_minutes:  $resolveMins,
            tier_business_hours:   false
          })
          CREATE (e)-[:HAS_SLA]->(s)
        `, {
          entityId:         ctx.entityId,
          tenantId:         ctx.tenantId,
          entityType:       ctx.entityType,
          startedAt:        startedAt.toISOString(),
          responseDeadline: responseDeadline.toISOString(),
          resolveDeadline:  resolveDeadline.toISOString(),
          responseMins,
          resolveMins,
        })
      }, true)
      break
    }
  }
}
