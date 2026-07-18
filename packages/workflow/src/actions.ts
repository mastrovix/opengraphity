import { v4 as uuidv4 } from 'uuid'
import { Queue } from 'bullmq'
import pino from 'pino'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type {
  WorkflowActionConfig,
  WorkflowInstance,
  ActionContext,
  ConditionDef,
  CreateEntityParams,
  AssignToParams,
  UpdateFieldParams,
  CallWebhookParams,
  CreateApprovalRequestParams,
} from './types.js'

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'workflow:actions' })

const redisConnection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
}

// ── Webhook retry job data ────────────────────────────────────────────────────

export interface WebhookRetryJobData {
  type:     'webhook_retry'
  url:      string
  method:   string
  headers:  Record<string, string>
  payload:  string
  attempt:  number
  tenantId: string
  entityId: string
}

// ── SSRF protection ───────────────────────────────────────────────────────────

const PRIVATE_IP_RE = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./,   // link-local
  /^::1$/,
  /^fc00:/,        // IPv6 unique-local
]

function isSafeWebhookUrl(raw: string): boolean {
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  if (process.env['NODE_ENV'] !== 'development' && parsed.protocol !== 'https:') return false
  const h = parsed.hostname
  if (h === 'localhost') return false
  if (PRIVATE_IP_RE.some((re) => re.test(h))) return false
  return true
}

// ── Template resolver ─────────────────────────────────────────────────────────

export function resolveTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (match, path: string) => {
    const parts = path.trim().split('.')
    let value: unknown = ctx
    for (const part of parts) {
      if (value == null || typeof value !== 'object') { value = null; break }
      value = (value as Record<string, unknown>)[part]
    }
    // Fallback: if dotted traversal failed (e.g. "{incident.title}" on a flat entityData),
    // try the last segment as a flat key on ctx directly.
    if (value == null && parts.length > 1) {
      value = ctx[parts[parts.length - 1] ?? '']
    }
    return value != null ? String(value) : match
  })
}

// ── Condition evaluation ──────────────────────────────────────────────────────

function evalCondition(c: ConditionDef, data: Record<string, unknown>): boolean {
  const actual   = data[c.field]
  const expected = c.value
  switch (c.operator) {
    case 'eq':         return actual === expected
    case 'ne':         return actual !== expected
    case 'gt':         return Number(actual) >  Number(expected)
    case 'lt':         return Number(actual) <  Number(expected)
    case 'gte':        return Number(actual) >= Number(expected)
    case 'lte':        return Number(actual) <= Number(expected)
    case 'in':         return Array.isArray(expected) && expected.includes(actual)
    case 'not_in':     return Array.isArray(expected) && !expected.includes(actual)
    case 'contains':   return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
    case 'is_null':    return actual == null
    case 'is_not_null': return actual != null
    default:
      // Unknown operator = corrupt action config. Returning true would EXECUTE
      // the action on an invalid condition — the inverse of what a guard is for.
      throw new Error(`Unknown action condition operator: ${String(c.operator)} (field: ${c.field})`)
  }
}

export function evaluateConditions(
  conditions: ConditionDef[] | undefined,
  logic: 'AND' | 'OR' = 'AND',
  entityData: Record<string, unknown>,
): boolean {
  if (!conditions || conditions.length === 0) return true
  const results = conditions.map((c) => evalCondition(c, entityData))
  return logic === 'AND' ? results.every(Boolean) : results.some(Boolean)
}

// ── Main action runner ────────────────────────────────────────────────────────

export async function runAction(
  action: WorkflowActionConfig,
  instance: WorkflowInstance,
  ctx: ActionContext,
): Promise<void> {
  const now = new Date().toISOString()

  log.debug({ type: action.type, params: action.params }, 'workflow-action: running')

  // Evaluate conditions before running
  log.debug({ conditions: action.conditions, logic: action.conditions_logic }, 'workflow-action: evaluating conditions')
  if (!evaluateConditions(action.conditions, action.conditions_logic, ctx.entityData)) {
    log.info({ type: action.type, entityId: instance.entityId }, 'action skipped: conditions not met')
    return
  }

  switch (action.type) {

    // ── SLA ────────────────────────────────────────────────────────────────────

    case 'sla_start': {
      if (!action.params['sla_type']) throw new Error('sla_start: missing required param "sla_type"')
      const slaType = String(action.params['sla_type'])
      const event: DomainEvent<{ entity_id: string; entity_type: string; sla_type: string }> = {
        id:             uuidv4(),
        type:           `sla.${slaType}.start`,
        tenant_id:      instance.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       ctx.userId,
        payload: { entity_id: instance.entityId, entity_type: instance.entityType, sla_type: slaType },
      }
      await publish(event)
      break
    }

    case 'sla_stop':
    case 'sla_pause':
    case 'sla_resume': {
      if (!action.params['sla_type']) throw new Error(`${action.type}: missing required param "sla_type"`)
      const slaType = String(action.params['sla_type'])
      const verb    = action.type.replace('sla_', '')
      const event: DomainEvent<{ entity_id: string; sla_type: string }> = {
        id:             uuidv4(),
        type:           `sla.${slaType}.${verb}`,
        tenant_id:      instance.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       ctx.userId,
        payload: { entity_id: instance.entityId, sla_type: slaType },
      }
      await publish(event)
      break
    }

    // ── Events ─────────────────────────────────────────────────────────────────

    case 'notify':
    case 'publish_event': {
      // No fabricated "incident.unknown" fallback: an event action without an
      // event name is broken config.
      if (!action.params['event']) throw new Error(`${action.type}: missing required param "event"`)
      const eventType = String(action.params['event'])
      const event: DomainEvent<{ entity_id: string; triggered_by: string; target?: string; notes?: string }> = {
        id:             uuidv4(),
        type:           eventType,
        tenant_id:      instance.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       ctx.userId,
        payload: {
          entity_id:    instance.entityId,
          triggered_by: ctx.userId,
          ...(action.params['target'] ? { target: String(action.params['target']) } : {}),
          ...(ctx.notes              ? { notes: ctx.notes }                         : {}),
        },
      }
      await publish(event)
      break
    }

    case 'notify_rule':
      // handled separately via publishNotifyRuleActions in the GraphQL resolver
      break

    // ── Scheduled jobs ─────────────────────────────────────────────────────────

    case 'schedule_job': {
      if (!action.params['job']) throw new Error('schedule_job: missing required param "job"')
      const jobName = String(action.params['job'])
      const delayMs = parseInt(String(action.params['delay_hours'] ?? '0'), 10) * 60 * 60 * 1000
      const queue   = new Queue('workflow-jobs', { connection: redisConnection })
      await queue.add(
        jobName,
        { instanceId: instance.id, entityId: instance.entityId, tenantId: instance.tenantId, job: jobName },
        { delay: delayMs, jobId: `${jobName}:${instance.entityId}`, removeOnComplete: true },
      )
      await queue.close()
      break
    }

    case 'cancel_job': {
      if (!action.params['job']) throw new Error('cancel_job: missing required param "job"')
      const jobName = String(action.params['job'])
      const queue   = new Queue('workflow-jobs', { connection: redisConnection })
      const job     = await queue.getJob(`${jobName}:${instance.entityId}`)
      if (job) await job.remove()
      await queue.close()
      break
    }

    // ── New: create_entity ─────────────────────────────────────────────────────

    case 'create_entity': {
      // Fail-loud: a configured create_entity that cannot run means the derived
      // incident/problem/change will NOT exist — that must never be a warn.
      if (!ctx.createEntity) {
        throw new Error('create_entity: createEntity callback not provided by the calling context')
      }
      const p = action.params as unknown as CreateEntityParams
      const VALID_TYPES = new Set(['incident', 'problem', 'change'])
      if (!VALID_TYPES.has(p.entity_type)) {
        throw new Error(`create_entity: unsupported entity_type "${p.entity_type}"`)
      }
      const title = resolveTemplate(p.title_template ?? '', ctx.entityData)
      const data: Record<string, unknown> = { title, tenant_id: instance.tenantId }
      if (p.link_to_current) {
        data['parent_id']   = instance.entityId
        data['parent_type'] = instance.entityType
      }
      if (p.copy_fields) {
        for (const field of p.copy_fields) {
          if (field in ctx.entityData) data[field] = ctx.entityData[field]
        }
      }
      const newId = await ctx.createEntity(p.entity_type, data)
      log.info({ entityType: p.entity_type, newId }, 'workflow-action: create_entity succeeded')
      await ctx.publishEvent?.(`${p.entity_type}.created`, { id: newId, tenant_id: instance.tenantId, created_by: ctx.userId })
      break
    }

    // ── New: assign_to ────────────────────────────────────────────────────────

    case 'assign_to': {
      if (!ctx.assignTo) {
        throw new Error('assign_to: assignTo callback not provided by the calling context')
      }
      const p          = action.params as unknown as AssignToParams
      const resolvedId = p.target_id ?? resolveTemplate(p.target_name ?? '', ctx.entityData)
      if (!resolvedId) {
        throw new Error('assign_to: no target_id or target_name resolved — the entity was NOT assigned')
      }
      await ctx.assignTo(instance.entityId, p.target_type, resolvedId)
      await ctx.publishEvent?.(`${instance.entityType}.assigned`, {
        entity_id:   instance.entityId,
        target_type: p.target_type,
        target_id:   resolvedId,
        assigned_by: ctx.userId,
      })
      break
    }

    // ── New: update_field ─────────────────────────────────────────────────────

    case 'update_field': {
      if (!ctx.updateField) {
        throw new Error('update_field: updateField callback not provided by the calling context')
      }
      const p = action.params as unknown as UpdateFieldParams
      const ALLOWED_FIELDS = new Set(['severity', 'priority', 'status', 'description', 'category'])
      if (!ALLOWED_FIELDS.has(p.field)) {
        throw new Error(`update_field: field "${p.field}" is not in the allowed list (${[...ALLOWED_FIELDS].join(', ')})`)
      }
      const resolved = typeof p.value === 'string' ? resolveTemplate(p.value, ctx.entityData) : p.value
      await ctx.updateField(instance.entityId, p.field, resolved)
      await ctx.publishEvent?.(`${instance.entityType}.updated`, {
        entity_id:  instance.entityId,
        field:      p.field,
        value:      resolved,
        updated_by: ctx.userId,
      })
      break
    }

    // ── New: create_approval_request ─────────────────────────────────────────

    case 'create_approval_request': {
      // Fail-loud: a missing approval request leaves the workflow waiting for
      // an approval that will never arrive.
      if (!ctx.createApprovalRequest) {
        throw new Error('create_approval_request: callback not provided by the calling context')
      }
      const p     = action.params as unknown as CreateApprovalRequestParams
      const title = resolveTemplate(p.title_template ?? '', ctx.entityData)
      const approvalId = await ctx.createApprovalRequest({
        entityId:     instance.entityId,
        entityType:   instance.entityType,
        title,
        approverRole: p.approver_role,
        approvalType: p.approval_type,
      })
      log.info({ approvalId, entityId: instance.entityId }, 'workflow-action: create_approval_request succeeded')
      break
    }

    // ── New: call_webhook ─────────────────────────────────────────────────────

    case 'call_webhook': {
      const p = action.params as unknown as CallWebhookParams
      if (!isSafeWebhookUrl(p.url ?? '')) {
        // Misconfigured/blocked URL is a config error, not a silent skip.
        throw new Error(`call_webhook: URL blocked (SSRF/non-HTTPS): ${p.url}`)
      }
      const rawPayload = resolveTemplate(p.payload_template ?? '', ctx.entityData)
      if (rawPayload.length > 1_000_000) {
        throw new Error(`call_webhook: payload exceeds 1MB (${rawPayload.length} bytes) — not sent`)
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const t0    = Date.now()
      try {
        let failure: string | null = null
        try {
          const res = await fetch(p.url, {
            method:  p.method ?? 'POST',
            headers: { 'Content-Type': 'application/json', ...(p.headers ?? {}) },
            body:    p.method !== 'GET' ? rawPayload : undefined,
            signal:  controller.signal,
          })
          if (res.ok) {
            log.info({ url: p.url, status: res.status, durationMs: Date.now() - t0 }, 'call_webhook completed')
          } else {
            // A non-2xx response is a delivery failure — it must trigger the
            // retry path and surface, not be logged as "completed".
            failure = `HTTP ${res.status}`
          }
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err)
        }

        if (failure !== null) {
          log.error({ url: p.url, durationMs: Date.now() - t0, failure }, 'call_webhook failed — scheduling retry')

          // Solo se non è già un retry (evita loop). Se anche lo scheduling del
          // retry fallisce, l'errore propaga: il payload andrebbe perso per sempre.
          if (!ctx.isWebhookRetry) {
            const retryQueue = new Queue('workflow-jobs', { connection: redisConnection })
            try {
              await retryQueue.add(
                'webhook_retry',
                {
                  type:     'webhook_retry',
                  url:      p.url,
                  method:   p.method ?? 'POST',
                  headers:  p.headers ?? {},
                  payload:  rawPayload,
                  attempt:  1,
                  tenantId: instance.tenantId,
                  entityId: instance.entityId,
                } satisfies WebhookRetryJobData,
                {
                  attempts:  3,
                  backoff: { type: 'exponential', delay: 30_000 },
                  removeOnComplete: true,
                  removeOnFail:     false,
                },
              )
            } finally {
              await retryQueue.close()
            }
          }
          throw new Error(`call_webhook failed (${failure}) — ${ctx.isWebhookRetry ? 'retry attempt failed' : 'retry scheduled'}`)
        }
      } finally {
        clearTimeout(timer)
      }
      break
    }

    default:
      // Unknown action type = corrupt/newer config this engine can't run.
      throw new Error(`Unknown workflow action type: ${String((action as WorkflowActionConfig).type)}`)
  }
}
