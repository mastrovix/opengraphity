/**
 * Shared action executor — used by AutoTriggers and BusinessRules.
 * Each action executes in sequence; if one fails, remaining actions are skipped.
 */
import { v4 as uuidv4 } from 'uuid'
import pino from 'pino'
import { runQuery } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import { isNotificationTarget, AUTOMATION_NOTIFICATION_CHANNELS, TICKET_TEAM_ASSIGNED_EVENT, type AutomationNotificationPayload, type DomainEvent } from '@opengraphity/types'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import { ValidationError } from './errors.js'
import { assertSafeOutboundUrl, loggableUrl } from './safeUrl.js'
import { assertScriptingEnabled } from './scriptingPlan.js'

const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }).child({ module: 'action-executor' })

// ── set_field guard ──────────────────────────────────────────────────────────

/**
 * Properties an automation must never write directly: identity/tenancy
 * (`id`, `tenant_id`), sequence numbers (`number`, `code`), audit
 * (`created_at`, `created_by`), and `status`/`workflow_*` — status changes go
 * through the workflow engine only (`transition_workflow`), otherwise
 * WorkflowInstance and entity drift apart.
 */
export const SET_FIELD_FORBIDDEN = new Set([
  'id', 'tenant_id', 'number', 'code', 'created_at', 'created_by',
  'status', 'workflow_step', 'workflow_instance_id', 'updated_at',
])

const FIELD_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * Validates the `field` param of a `set_field` action. Returns the field name
 * or throws ValidationError. Exported for tests; pure.
 */
export function assertSettableField(raw: unknown): string {
  const field = typeof raw === 'string' ? raw : ''
  if (!field) throw new ValidationError('set_field: field is required')
  if (!FIELD_NAME_RE.test(field)) {
    throw new ValidationError(`set_field: invalid field name "${field}" (expected ^[a-z][a-z0-9_]*$)`)
  }
  if (SET_FIELD_FORBIDDEN.has(field)) {
    throw new ValidationError(`set_field: field "${field}" is protected and cannot be set by automation${field === 'status' ? ' — use transition_workflow' : ''}`)
  }
  return field
}

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

/** Le etichette dei ticket su cui un'azione può scrivere: allowlist, finisce nel Cypher. */
const TICKET_LABELS: Record<string, 'Incident' | 'Problem' | 'Change' | 'ServiceRequest'> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest',
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
 * Parses a JSON string of actions.
 *
 * Throws on malformed JSON or a non-array payload: returning [] would make a
 * matched rule silently execute zero actions — the rule looks healthy while
 * doing nothing. Callers surface the error and skip the rule.
 */
export function parseActions(raw: string | null | undefined): Action[] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Corrupt actions JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(arr)) {
    throw new Error(`Actions payload is not an array (got ${typeof arr})`)
  }
  return arr as Action[]
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
    case 'set_field':
    case 'set_priority': {
      // AU-3: la priorità e i campi della matrice passano da `writeTicketField`,
      // che scrive la proprietà giusta per il ticket e mantiene l'invariante.
      const field = action.type === 'set_priority' ? 'priority' : assertSettableField(p['field'])
      const value = action.type === 'set_priority' ? String(p['priority'] ?? p['value'] ?? '') : p['value']
      if (action.type === 'set_priority' && !value) throw new Error('set_priority: priority value is required')
      const { writeTicketField } = await import('./ticketFieldWrite.js')
      const written = await withSession((session) => writeTicketField(session, ctx.tenantId, ctx.entityType, ctx.entityId, field, value), true)
      // L'aggiornamento si pubblica (webhook, notifiche); le automazioni non lo
      // rivalutano, perché l'attore è l'automazione (consumers/automationConsumer.ts).
      if (ctx.entityType !== 'change') {
        const { publishTicketUpdated } = await import('./ticketUpdated.js')
        await publishTicketUpdated({ tenantId: ctx.tenantId, userId: ctx.userId }, ctx.entityType as 'incident' | 'problem' | 'service_request', ctx.entityId, written.before, written.after)
      }
      break
    }

    case 'assign_team': {
      const teamId = String(p['team_id'] ?? '')
      if (!teamId) throw new Error('assign_team: team_id is required')
      // Come l'assegnazione fatta a mano: per un incident passa dal servizio,
      // che fa avanzare il workflow dal passo iniziale, scrive la nota e
      // pubblica l'evento. Prima una regola scriveva solo la relazione, e
      // l'incident restava «Nuovo» con il team già assegnato (giro del 14 set
      // 2026). Per gli altri ticket: la stessa scrittura, con l'etichetta giusta.
      if (ctx.entityType === 'incident') {
        const { assignIncidentToTeam } = await import('../services/incidentService.js')
        await assignIncidentToTeam(ctx.entityId, teamId, { tenantId: ctx.tenantId, userId: ctx.userId })
      } else if (ctx.entityType === 'problem') {
        const { setTicketTeam } = await import('../services/ticketAssignment.js')
        await withSession((session) => setTicketTeam(session, 'Problem', ctx.entityId, teamId, ctx.tenantId), true)
        await publish({ id: uuidv4(), type: TICKET_TEAM_ASSIGNED_EVENT, tenant_id: ctx.tenantId, timestamp: now, correlation_id: uuidv4(), actor_id: ctx.userId,
          payload: { entity_type: 'problem', entity_id: ctx.entityId, team_id: teamId } })
      } else {
        const label = TICKET_LABELS[ctx.entityType]
        if (!label) throw new Error(`assign_team: entity type "${ctx.entityType}" has no team assignment`)
        await withSession(async (session) => {
          const rows = await runQuery<{ ok: unknown }>(session, `
            MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
            MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
            OPTIONAL MATCH (e)-[old:ASSIGNED_TO_TEAM]->()
            DELETE old
            WITH DISTINCT e, t
            CREATE (e)-[:ASSIGNED_TO_TEAM]->(t)
            SET e.updated_at = $now
            RETURN 1 AS ok
          `, { entityId: ctx.entityId, tenantId: ctx.tenantId, teamId, now })
          if (rows.length === 0) throw new Error(`assign_team: ${ctx.entityType} ${ctx.entityId} or team ${teamId} not found`)
        }, true)
      }
      break
    }

    case 'assign_user': {
      const userId = String(p['user_id'] ?? '')
      if (!userId) throw new Error('assign_user: user_id is required')
      // AU-5 (revisione del 14 set 2026): prima si toglieva l'assegnatario e poi
      // si cercava l'utente — se non esisteva nel tenant il ticket restava
      // senza nessuno e l'azione risultava riuscita — e non valeva «prima il
      // gruppo, poi un suo membro», la regola dell'assegnazione a mano. Ora la
      // stessa strada: il servizio per l'incident, ticketAssignment per il
      // problem, e per gli altri ticket la scrittura che conta le righe.
      if (ctx.entityType === 'incident') {
        const { assignIncidentToUser } = await import('../services/incidentService.js')
        await assignIncidentToUser(ctx.entityId, userId, { tenantId: ctx.tenantId, userId: ctx.userId })
      } else if (ctx.entityType === 'problem') {
        const { assertUserInAssignedTeam, setTicketUser } = await import('../services/ticketAssignment.js')
        await withSession(async (session) => {
          await assertUserInAssignedTeam(session, 'Problem', ctx.entityId, userId, ctx.tenantId)
          await setTicketUser(session, 'Problem', ctx.entityId, userId, ctx.tenantId)
        }, true)
      } else {
        const label = TICKET_LABELS[ctx.entityType]
        if (!label) throw new Error(`assign_user: entity type "${ctx.entityType}" has no assignee`)
        await withSession(async (session) => {
          const rows = await runQuery<{ ok: unknown }>(session, `
            MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
            MATCH (u:User {id: $userId, tenant_id: $tenantId})
            OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->()
            DELETE old
            WITH DISTINCT e, u
            CREATE (e)-[:ASSIGNED_TO]->(u)
            SET e.updated_at = $now
            RETURN 1 AS ok
          `, { entityId: ctx.entityId, tenantId: ctx.tenantId, userId, now })
          if (rows.length === 0) throw new Error(`assign_user: ${ctx.entityType} ${ctx.entityId} or user ${userId} not found`)
        }, true)
      }
      break
    }

    case 'transition_workflow': {
      const toStep = String(p['to_step'] ?? '')
      if (!toStep) throw new Error('transition_workflow: to_step is required')
      const { workflowEngine } = await import('@opengraphity/workflow')
      // Import differito come quello sopra: `lib/` non deve dipendere da
      // `graphql/resolvers/` al caricamento del modulo.
      const { assertAutomaticTransitionAllowed } = await import('../graphql/resolvers/change/windowGate.js')
      await withSession(async (session) => {
        const wiRes = await session.executeRead(tx => tx.run(`
          MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          OPTIONAL MATCH (wi)-[:CURRENT_STEP]->(cur:WorkflowStep)
          // Serve al varco della finestra di rilascio: questa azione transisce
          // QUALUNQUE entita con un workflow, change comprese.
          RETURN wi.id AS instanceId, cur.name AS currentStep,
                 CASE WHEN 'Change' IN labels(e) THEN e.id          ELSE null END AS changeId,
                 CASE WHEN 'Change' IN labels(e) THEN e.change_type ELSE null END AS changeType
        `, { entityId: ctx.entityId, tenantId: ctx.tenantId }))
        if (wiRes.records.length === 0) throw new Error('No workflow instance found')
        const instanceId = wiRes.records[0].get('instanceId') as string

        // IL VARCO DELLA FINESTRA DI RILASCIO (terza revisione * C1, quarto
        // cammino). Questa azione e configurabile dall'interfaccia — pagine
        // «Business Rules» e «Trigger Automatici» — e il suo `to_step` arriva
        // dai parametri: una regola con bersaglio il passo programmato
        // spingeva qualunque change dentro la finestra di rilascio senza
        // approvazioni. Nessuno dei due revisori l'aveva visto; l'ho trovato
        // contando i chiamanti di `workflowEngine.transition` (erano 14, non 3).
        const changeId   = wiRes.records[0].get('changeId')   as string | null
        const changeType = wiRes.records[0].get('changeType') as string | null
        if (changeId) {
          await assertAutomaticTransitionAllowed(session, {
            tenantId:    ctx.tenantId,
            changeId,
            changeType:  changeType ?? '',
            currentStep: (wiRes.records[0].get('currentStep') as string | null) ?? '',
            toStep,
          }, 'rule_action')
        }
        const result = await workflowEngine.transition(session, {
          instanceId, toStepName: toStep,
          triggeredBy: 'system', triggerType: 'automatic',
          notes: `Auto: ${ctx.sourceName}`,
        }, { userId: ctx.userId, entityData: ctx.entity })
        // B-18: l'esito del motore era IGNORATO. Un `to_step` che non esiste
        // più (passo rinominato o tolto dal disegnatore), o un arco non
        // percorribile, faceva risultare l'azione eseguita e la regola sana:
        // il ticket non si muoveva e nessuno lo sapeva. Ora è un errore
        // dell'azione, che nomina il bersaglio e finisce nel risultato della
        // regola (`matched + error`) e nei log.
        if (!result.success) {
          throw new Error(
            `transition_workflow: the transition to "${toStep}" did not happen (${result.error ?? 'unknown engine error'}). ` +
            `Check that "${toStep}" is still a step of the ${ctx.entityType} workflow and that an edge leaves the current step.`,
          )
        }
      }, true)
      break
    }

    case 'create_notification': {
      const message = String(p['message'] ?? '')
      if (!message.trim()) throw new Error('create_notification action requires a non-empty message')
      const channel = String(p['channel'] ?? 'in_app')
      if (!AUTOMATION_NOTIFICATION_CHANNELS.includes(channel)) {
        throw new Error(`create_notification: channel "${channel}" is not supported (${AUTOMATION_NOTIFICATION_CHANNELS.join(', ')})`)
      }
      // A chi: un bersaglio del vocabolario delle notifiche. Un'azione scritta
      // prima che il bersaglio esistesse vale per tutto il tenant, lo stesso
      // default dichiarato delle regole di notifica (`all`).
      const target = String(p['target'] ?? 'all')
      if (!isNotificationTarget(target)) throw new Error(`create_notification: unknown recipient "${target}"`)
      const event: DomainEvent<AutomationNotificationPayload> = {
        id:             uuidv4(),
        type:           'automation.notification',
        tenant_id:      ctx.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       ctx.userId,
        // Prima questo evento non aveva nessun consumatore: l'azione «risultava»
        // eseguita e nessuno riceveva niente (revisione del 14 set 2026 · AU-2).
        // Lo consegna il dispatcher delle notifiche.
        payload: { entity_id: ctx.entityId, entity_type: ctx.entityType, message, channel, target, rule: ctx.sourceName },
      }
      await publish(event)
      break
    }

    case 'create_comment': {
      const text = String(p['text'] ?? p['message'] ?? '')
      if (!text) throw new Error('create_comment: text is required')
      // Un modello di commento per tutti i ticket (lib/ticketComments.ts): nota
      // interna, `author_label` dice CHI l'ha scritto — la regola — invece di
      // «utente sconosciuto».
      if (!TICKET_LABELS[ctx.entityType]) throw new Error(`create_comment: entity type "${ctx.entityType}" has no comments`)
      const { writeTicketComment } = await import('./ticketComments.js')
      const written = await withSession((session) => writeTicketComment(session, {
        entityType: ctx.entityType, entityId: ctx.entityId, tenantId: ctx.tenantId,
        text, authorId: 'system', authorLabel: ctx.sourceName, isInternal: true, createdAt: now,
      }), true)
      if (!written) throw new Error(`create_comment: ${ctx.entityType} ${ctx.entityId} not found`)
      break
    }

    case 'execute_script': {
      const code = String(p['code'] ?? '')
      if (!code) throw new Error('execute_script: code is required')
      // Limite di piano (D-12): l'automazione è del cliente, quindi passa dal
      // limite. Piano senza script → l'azione non gira e l'errore lo dice
      // (l'esecuzione dell'automazione fallisce e resta visibile), invece di
      // essere saltata in silenzio.
      await assertScriptingEnabled(ctx.tenantId, `execute_script action of "${ctx.sourceName}"`, 'errors.scripting.what.action', { source: ctx.sourceName })
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
      // SSRF guard + https-only outside development (policy in safeUrl) —
      // the full entity is posted to this URL, so an internal target would
      // both hit internal services and exfiltrate data.
      await assertSafeOutboundUrl(url)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const payload = JSON.stringify({ entity: ctx.entity, entityType: ctx.entityType, source: ctx.source, rule: ctx.sourceName })
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body:    method !== 'GET' ? payload : undefined,
          signal:  controller.signal,
        })
        if (!res.ok) throw new Error(`Webhook ${loggableUrl(url)} returned ${res.status}`)
      } finally {
        clearTimeout(timer)
      }
      break
    }

    case 'set_sla': {
      // Dal motore SLA (AU-4): fuso del tenant, stato sostituito con i suoi
      // job annullati, avviso/breach/risposta programmati.
      const { applyRuleSLA } = await import('@opengraphity/sla')
      await applyRuleSLA({
        tenantId: ctx.tenantId, entityType: ctx.entityType, entityId: ctx.entityId,
        responseMinutes: Number(p['response_minutes']), resolveMinutes: Number(p['resolve_minutes']),
        ...(p['warning_minutes'] != null ? { warningMinutes: Number(p['warning_minutes']) } : {}),
        ruleName: ctx.sourceName,
      })
      break
    }
  }
}
