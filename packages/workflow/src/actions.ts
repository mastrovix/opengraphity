import { v4 as uuidv4 } from 'uuid'
import { Queue } from 'bullmq'
import pino from 'pino'
import { publish, assertSafeOutboundUrl, loggableUrl, getRedisConnection } from '@opengraphity/events'
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
  CreateTaskParams,
} from './types.js'
import { stepFieldRejection } from '@opengraphity/types'
import { currentTaskCreator } from './taskCreator.js'

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'workflow:actions' })

// Connessione Redis unica del monorepo (packages/events): REDIS_URL/HOST/PASSWORD, fail-fast in prod.
const redisConnection = getRedisConnection()

// ── Webhook retry job data ────────────────────────────────────────────────────

/**
 * Il job del retry NON porta gli header (revisione totale · E-11): erano in
 * chiaro in Redis — tipicamente un `Authorization` del cliente — e con
 * `removeOnFail: false` restavano lì per sempre. Il worker li rilegge dal passo
 * del workflow (stepId), che è la sorgente della configurazione.
 */
export interface WebhookRetryJobData {
  type:     'webhook_retry'
  url:      string
  method:   string
  payload:  string
  /** Il passo che ha l'azione `call_webhook`: da lì il worker rilegge gli header. */
  stepId?:  string
  actionIndex?: number
  attempt:  number
  tenantId: string
  entityId: string
}

// SSRF protection: shared `assertSafeOutboundUrl` from @opengraphity/events
// (scheme, private/loopback literals, DNS resolution) — no local copy.

// ── Template resolver ─────────────────────────────────────────────────────────

/**
 * Resolves `{path.to.field}` placeholders against ctx.
 *
 * No guessing: an unresolved placeholder THROWS. The old behaviour left the
 * literal `{incident.title}` in created entities/webhook payloads, and a
 * "last segment as flat key" fallback could silently resolve a DIFFERENT
 * field than the one the template named. Callers namespace the context
 * (see buildTemplateCtx) so both `{title}` and `{incident.title}` resolve
 * legitimately.
 */
export function resolveTemplate(template: string, ctx: Record<string, unknown>): string {
  // Solo `{a.b.c}`: le graffe di un body JSON (`{"id":"{incident.id}"}`) non sono placeholder.
  return template.replace(/\{([A-Za-z_][\w.]*)\}/g, (_match, path: string) => {
    const parts = path.trim().split('.')
    let container: Record<string, unknown> | null = ctx
    let value: unknown = ctx
    let exists = true
    for (const part of parts) {
      if (value == null || typeof value !== 'object') { exists = false; break }
      container = value as Record<string, unknown>
      if (!Object.prototype.hasOwnProperty.call(container, part)) { exists = false; break }
      value = container[part]
    }
    /**
     * Un campo che NON ESISTE nel contesto è un template sbagliato: si ferma,
     * come prima. Un campo che esiste ed è VUOTO è un dato legittimo (un
     * incident aperto dal portale senza descrizione, una categoria non
     * scelta): risolve alla stringa vuota (revisione totale · E-10). Prima
     * faceva fallire l'intera azione — `create_entity`, `update_field`,
     * `call_webhook`, `assign_to` — e non c'era modo di scrivere un template
     * tollerante.
     */
    if (!exists) {
      throw new Error(`resolveTemplate: placeholder {${path.trim()}} did not resolve (available keys: ${Object.keys(ctx).join(', ')})`)
    }
    return value == null ? '' : String(value)
  })
}

/**
 * Template context: the flat entity properties plus the same object namespaced
 * under its entity type, so seeded templates written as `{incident.title}`
 * and `{title}` both resolve without any flat-key guessing.
 */
function buildTemplateCtx(instance: WorkflowInstance, entityData: Record<string, unknown>): Record<string, unknown> {
  return { ...entityData, [instance.entityType]: entityData }
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
      const title = resolveTemplate(p.title_template ?? '', buildTemplateCtx(instance, ctx.entityData))
      const data: Record<string, unknown> = { title, tenant_id: instance.tenantId }
      if (p.change_type) data['change_type'] = p.change_type
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
      // L'evento di creazione lo pubblica chi crea il ticket (il servizio del
      // suo tipo, revisione del 14 set 2026 · WA-2): pubblicarlo anche qui lo
      // duplicava, con un payload che nessun consumatore sapeva leggere.
      log.info({ entityType: p.entity_type, newId }, 'workflow-action: create_entity succeeded')
      break
    }

    // ── New: assign_to ────────────────────────────────────────────────────────

    case 'assign_to': {
      if (!ctx.assignTo) {
        throw new Error('assign_to: assignTo callback not provided by the calling context')
      }
      const p          = action.params as unknown as AssignToParams
      const resolvedId = p.target_id ?? resolveTemplate(p.target_name ?? '', buildTemplateCtx(instance, ctx.entityData))
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
      // Campi riservati in @opengraphity/types: la stessa regola vale a
      // runtime, in scrittura (`assertStepActions`) e nel disegnatore. `status`
      // non è scrivibile (B-9): lo scrive il motore, e scavalcarlo faceva
      // divergere il ticket dal suo processo. L'esistenza del campo nel
      // metamodello e il vocabolario li verifica chi scrive (`ctx.updateField`).
      const rejection = stepFieldRejection(p.field, instance.entityType)
      if (rejection) throw new Error(rejection.message)
      const resolved = typeof p.value === 'string' ? resolveTemplate(p.value, buildTemplateCtx(instance, ctx.entityData)) : p.value
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
    // (il lettore delle due forme di `approver_*_ids` è `approverIdList`, in fondo)

    case 'create_approval_request': {
      // Fail-loud: a missing approval request leaves the workflow waiting for
      // an approval that will never arrive.
      if (!ctx.createApprovalRequest) {
        throw new Error('create_approval_request: callback not provided by the calling context')
      }
      const p     = action.params as unknown as CreateApprovalRequestParams
      const title = resolveTemplate(p.title_template ?? '', buildTemplateCtx(instance, ctx.entityData))
      const approvalId = await ctx.createApprovalRequest({
        entityId:     instance.entityId,
        entityType:   instance.entityType,
        title,
        approverRole: p.approver_role,
        // Persone e squadre (moduli del catalogo, ondata 3): l'insieme degli
        // approvatori e l'unione dei tre, senza ripetizioni.
        approverUserIds: approverIdList(p.approver_user_ids),
        approverTeamIds: approverIdList(p.approver_team_ids),
        approvalType: p.approval_type,
      })
      log.info({ approvalId, entityId: instance.entityId }, 'workflow-action: create_approval_request succeeded')
      break
    }

    // ── New: create_task ─────────────────────────────────────────────────────

    /**
     * UN COMPITO DA FARE per una squadra, creato entrando nel passo.
     *
     * Chi lo scrive nel grafo è il REGISTRO (`taskCreator.ts`), non un
     * callback del contesto: tre dei cinque punti che costruiscono un
     * `ActionContext` lo costruiscono povero, e fra quelli c'è il cammino
     * dell'approvazione — cioè proprio «richiesta approvata → partono i
     * compiti». Con un callback, lì i compiti non sarebbero nati e la
     * transizione sarebbe riuscita lo stesso.
     *
     * Il TIPO del compito non è un parametro: è `instance.entityType`, cioè
     * il tipo dell'entità di questo workflow. È la prima delle tre difese
     * sulla regola «un compito di tipo incident non sta su una change» —
     * qui non si può nemmeno esprimere.
     */
    case 'create_task': {
      /**
       * SOLO ALL'INGRESSO (rimedio, 20 set 2026). Il motore esegue le azioni
       * di uscita con l'istanza già spostata sul passo NUOVO, quindi un
       * compito creato uscendo da A nascerebbe timbrato «passo B»: non
       * bloccherebbe l'uscita da A — che è il senso della guardia — e
       * bloccherebbe quella da B. Chi disegna non ha modo di accorgersene,
       * quindi la strada si chiude qui, in scrittura (`assertStepActions`) e
       * nel disegnatore, che non la offre più fra le azioni di uscita.
       */
      if (ctx.actionPhase === 'exit') {
        throw new Error(
          'create_task: a task can only be created ENTERING a step, not leaving one — ' +
          'on exit it would be stamped with the step being entered, and would guard the wrong step',
        )
      }
      const creaCompito = currentTaskCreator()
      if (!creaCompito) {
        throw new Error('create_task: nobody registered a task creator in this process (registerTaskCreator)')
      }
      const p     = action.params as unknown as CreateTaskParams
      const title = resolveTemplate(p.title_template ?? '', buildTemplateCtx(instance, ctx.entityData)).trim()
      // Un compito senza titolo è una riga vuota in «I miei compiti»: chi la
      // trova non sa cosa deve fare, e non c'è modo di indovinarlo.
      if (!title) throw new Error('create_task: empty title — the task would say nothing to whoever has to do it')

      const giorni = p.due_in_days == null || p.due_in_days === '' ? null : Number(p.due_in_days)
      if (giorni !== null && (!Number.isFinite(giorni) || giorni < 0)) {
        throw new Error(`create_task: "due_in_days" is not a number of days (${String(p.due_in_days)})`)
      }

      const taskId = await creaCompito({
        tenantId:    instance.tenantId,
        entityId:    instance.entityId,
        entityType:  instance.entityType,
        stepName:    instance.currentStep,
        // La posizione nella PROPRIA lista, non nella concatenata: è l'unica
        // stabile, e finisce nella chiave naturale contro i doppioni.
        actionIndex: ctx.actionPosition ?? ctx.actionIndex ?? 0,
        title,
        description: p.description?.trim() || null,
        teamId:        p.team_id?.trim() || null,
        teamFromField: p.team_from_field?.trim() || null,
        dueInDays:   giorni,
        // Il compito da aspettare si nomina col suo titolo, e il titolo può
        // avere i segnaposto: si risolve con lo stesso contesto, altrimenti
        // «Prepara {title}» non combacerebbe mai con quello che è nato.
        after:       p.after?.trim() ? resolveTemplate(p.after.trim(), buildTemplateCtx(instance, ctx.entityData)) : null,
        createdBy:   ctx.userId,
      })
      log.info({ taskId, entityId: instance.entityId, entityType: instance.entityType }, 'workflow-action: create_task succeeded')
      break
    }

    // ── New: call_webhook ─────────────────────────────────────────────────────

    case 'call_webhook': {
      const p = action.params as unknown as CallWebhookParams
      // Misconfigured/blocked URL is a config error, not a silent skip:
      // UnsafeUrlError propagates with the reason (scheme, private IP, DNS).
      await assertSafeOutboundUrl(p.url ?? '')
      const safeHost = loggableUrl(p.url)
      const rawPayload = resolveTemplate(p.payload_template ?? '', buildTemplateCtx(instance, ctx.entityData))
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
            log.info({ host: safeHost, status: res.status, durationMs: Date.now() - t0 }, 'call_webhook completed')
          } else {
            // A non-2xx response is a delivery failure — it must trigger the
            // retry path and surface, not be logged as "completed".
            failure = `HTTP ${res.status}`
          }
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err)
        }

        if (failure !== null) {
          log.error({ host: safeHost, durationMs: Date.now() - t0, failure }, 'call_webhook failed — scheduling retry')

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
                  payload:  rawPayload,
                  ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
                  ...(typeof ctx.actionIndex === 'number' ? { actionIndex: ctx.actionIndex } : {}),
                  attempt:  1,
                  tenantId: instance.tenantId,
                  entityId: instance.entityId,
                } satisfies WebhookRetryJobData,
                {
                  attempts:  3,
                  backoff: { type: 'exponential', delay: 30_000 },
                  removeOnComplete: true,
                  // Sette giorni, non «per sempre»: il payload di un webhook non resta in Redis a vita (E-11).
                  removeOnFail:     { age: 7 * 24 * 3600 },
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


/**
 * Gli id degli approvatori, da una lista JSON o da una stringa separata da
 * virgola. È l'UNICO posto che legge le due forme: il disegnatore scrive una
 * stringa (il suo editor tiene i parametri come `Record<string, string>`),
 * l'API può scrivere un array. Vuoto = nessun id indicato, che non è lo stesso
 * di «nessun approvatore»: senza id vale il ruolo.
 */
export function approverIdList(raw: string[] | string | undefined): string[] {
  if (raw == null) return []
  const parti = Array.isArray(raw) ? raw : raw.split(',')
  return [...new Set(parti.map((v) => String(v).trim()).filter((v) => v !== ''))]
}
