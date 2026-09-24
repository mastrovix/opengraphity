import type { Job, Queue } from 'bullmq'
import type { TenantWorkerPool } from '@opengraphity/events'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { WAIT_EXIT_TRIGGERS } from '@opengraphity/workflow'
import { logger } from '../lib/logger.js'
import { createTenantWorkers, getTenantQueue } from '../lib/bullmq.js'
import { evaluateConditions, parseConditions } from '../lib/conditionEvaluator.js'
import { executeActions, parseActions, type ActionExecutionContext } from '../lib/actionExecutor.js'
import { assertSafeOutboundUrl, loggableUrl } from '../lib/safeUrl.js'
import { transitionTicket } from '../services/ticketTransition.js'
import { loadAutomationEntity } from '../lib/automationEntity.js'
import { DEADLINE_REASON, runStepDeadlineSweep } from '../lib/stepDeadlines.js'
import { runOLASweep } from '../lib/olaSweep.js'
import { runSLASweep } from '@opengraphity/sla'
import { AUTOMATION_ACTOR, type AutomationEntityType } from '@opengraphity/types'

/*
 * I NOMI DELLE CODE E DEI LAVORI, in testa al file: la tabella `PASSATE` qui
 * sotto li usa, e in JavaScript un `const` non si può leggere prima di dove è
 * dichiarato (22 set 2026 — questo file li teneva in fondo, e la tabella non
 * compilava).
 */
export const NOTIFICATION_JOBS_QUEUE = 'notification-jobs'
export const WORKFLOW_JOBS_QUEUE     = 'workflow-jobs'
/** Il job ripetuto delle scadenze dei passi, ogni minuto. */
export const STEP_DEADLINES_JOB      = 'step_deadlines'
export const STEP_DEADLINES_EVERY_MS = 60_000
export const OLA_SWEEP_JOB = 'ola_sweep'
/** La ripresa delle transizioni automatiche perdute (22 set 2026). */
export const RIPRESA_JOB = 'ripresa_transizioni'
/*
 * Cinque minuti, non uno: qui non si insegue una scadenza ma si rimedia a
 * un'occasione persa, e un'occasione persa lo resta anche per cinque minuti.
 * Più raro significa anche meno letture inutili sui clienti che non hanno
 * niente di fermo — che sono quasi tutti, quasi sempre.
 */
export const RIPRESA_EVERY_MS = 5 * 60_000
export const OLA_SWEEP_EVERY_MS = 60_000
/** Wave 7 · A1: the SLA timers Redis lost, fired from the graph (packages/sla/src/sweep.ts). */
export const SLA_SWEEP_JOB = 'sla_sweep'
export const SLA_SWEEP_EVERY_MS = 60_000
/** Wave 7 · B2: the domain events written to the outbox and never marked sent, sent again (lib/outbox.ts). */
export const OUTBOX_RESEND_JOB = 'outbox_resend'
export const OUTBOX_RESEND_EVERY_MS = 30_000


// ── Job data shape produced by packages/workflow/src/actions.ts ───────────────

interface WorkflowJobData {
  instanceId: string
  entityId:   string
  tenantId:   string
  job:        string
}

// ── Webhook retry job data (mirrors WebhookRetryJobData from packages/workflow) ─

interface WebhookRetryData {
  type:     'webhook_retry'
  url:      string
  method:   string
  payload:  string
  attempt:  number
  tenantId: string
  entityId: string
  /** Il passo che porta l'azione `call_webhook` e la sua posizione fra le azioni del passo. */
  stepId?:      string
  actionIndex?: number
  /** Job accodati prima della revisione: portavano gli header dentro il job. */
  headers?: Record<string, string>
}

/**
 * Gli header del webhook, riletti dal passo del workflow (revisione totale ·
 * E-11): nel job non ci sono più, perché un token del cliente non deve stare in
 * chiaro in Redis. Un passo o un'azione che non c'è più: nessun header, e il
 * tentativo prosegue (l'URL e il payload sono nel job). I job vecchi, accodati
 * prima di questa modifica, usano gli header che portano con sé.
 */
async function webhookRetryHeaders(d: WebhookRetryData): Promise<Record<string, string>> {
  if (!d.stepId) return d.headers ?? {}
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ enterActions: string | null; exitActions: string | null }>(session, `
      MATCH (s:WorkflowStep {id: $stepId, tenant_id: $tenantId})
      RETURN s.enter_actions AS enterActions, s.exit_actions AS exitActions
    `, { stepId: d.stepId, tenantId: d.tenantId })
    const row = rows[0]
    if (!row) {
      logger.warn({ stepId: d.stepId }, '[webhook_retry] the step no longer exists: retrying without its headers')
      return {}
    }
    const parse = (raw: string | null): Array<{ type?: string; params?: Record<string, unknown> }> => {
      try { return raw ? JSON.parse(raw) as Array<{ type?: string; params?: Record<string, unknown> }> : [] } catch { return [] }
    }
    const actions = [...parse(row.exitActions), ...parse(row.enterActions)]
    const action = typeof d.actionIndex === 'number' ? actions[d.actionIndex] : actions.find((a) => a.type === 'call_webhook')
    const headers = action?.type === 'call_webhook' ? action.params?.['headers'] : undefined
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) return headers as Record<string, string>
    return {}
  } finally {
    await session.close()
  }
}

// SSRF protection: shared assertSafeOutboundUrl (lib/safeUrl.ts → @opengraphity/events).

// ── Processor ─────────────────────────────────────────────────────────────────

/**
 * Le passate periodiche di un tenant, per nome del lavoro: girano nella coda
 * del tenant (`workflow-jobs@<tenant>`, 23 set 2026) e guardano solo i suoi
 * dati. Ognuna scrive solo quando ha fatto qualcosa: una riga «zero» ogni
 * minuto insegna a non leggere i log.
 */
const PASSATE: Record<string, ((tenantId: string) => Promise<void>) | undefined> = {
  [STEP_DEADLINES_JOB]: async (tenantId) => {
    // Verifica «Cosa resta cablato», ondata 3: le scadenze dei passi. La
    // passata cerca i ticket fermi oltre la scadenza del loro passo e li
    // sposta; l'esito resta sull'esecuzione del passo (lib/stepDeadlines.ts).
    const summary = await runStepDeadlineSweep(tenantId)
    if (summary.moved + summary.refused + summary.failed > 0) logger.info({ tenantId, ...summary }, '[workflow-jobs] step deadlines')
  },
  [OLA_SWEEP_JOB]: async (tenantId) => {
    // Secondo giro UI del 15 set 2026: gli avvisi OLA/UC sul tempo del team (lib/olaSweep.ts).
    const summary = await runOLASweep(tenantId)
    if (summary.alerted + summary.failed > 0) logger.info({ tenantId, ...summary }, '[workflow-jobs] OLA sweep')
    if (summary.failed > 0) throw new Error(`OLA sweep: ${summary.failed} contract(s) could not be evaluated (see the log)`)
  },
  [SLA_SWEEP_JOB]: async (tenantId) => {
    const summary = await runSLASweep(tenantId)
    if (summary.warnings + summary.breaches + summary.responses + summary.failed > 0) logger.info({ tenantId, ...summary }, '[workflow-jobs] SLA sweep: timers recovered from the graph')
    if (summary.failed > 0) throw new Error(`SLA sweep: ${summary.failed} timer(s) could not fire (see the log)`)
  },
  [OUTBOX_RESEND_JOB]: async (tenantId) => {
    const { resendPendingEvents } = await import('../lib/outbox.js')
    const summary = await resendPendingEvents(tenantId)
    if (summary.sent + summary.failed > 0) logger.warn({ tenantId, ...summary }, '[workflow-jobs] outbox: events that had not left were sent again')
    if (summary.failed > 0) throw new Error(`Outbox: ${summary.failed} event(s) could not be sent again (see the log): the next pass tries again`)
  },
  [RIPRESA_JOB]: async (tenantId) => {
    const { riprendiTransizioniDi } = await import('../lib/riprendiTransizioni.js')
    const esito = await riprendiTransizioniDi(tenantId)
    // Si scrive solo quando è successo qualcosa (vedi lib/riprendiTransizioni.ts).
    if (esito.mosse > 0 || esito.rifiutateDalVarco > 0) logger.info({ tenantId, ...esito }, 'automatic transitions resumed')
  },
}

async function processWorkflowJob(job: Job<WorkflowJobData>): Promise<void> {
  const { entityId, tenantId } = job.data
  // Le passate periodiche girano ogni minuto: il loro log è il riepilogo, non questa riga.
  if (!PASSATE[job.name]) logger.info({ jobName: job.name, entityId, tenantId }, '[workflow-jobs] processing')

  /*
   * LE PASSATE PERIODICHE STANNO IN UNA TABELLA, non in tre `case` (22 set
   * 2026). Sono tutte la stessa forma — «chiama la passata, scrivi solo se ha
   * fatto qualcosa» — e tenerle qui faceva crescere questo dispatcher a ogni
   * passata nuova: `check-funzioni-lunghe` l'ha vista superare le 60
   * istruzioni proprio aggiungendo la terza.
   */
  const passata = PASSATE[job.name]
  if (passata) { await passata(tenantId); return }

  switch (job.name) {
    case 'auto_close': {
      // I job `auto_close` messi in coda PRIMA dell'ondata 3 (72 ore di
      // ritardo) arrivano ancora per qualche giorno dopo l'aggiornamento. Non
      // c'è niente da fare: lo stesso ticket lo chiude la scadenza del passo
      // «resolved», nata dalla migrazione 20260925_1200 con la stessa durata.
      logger.info({ entityId, tenantId }, '[workflow-jobs] auto_close di prima dell\'ondata 3: lo fa la scadenza del passo, il job non fa nulla')
      break
    }

    case 'webhook_retry': {
      const d = job.data as unknown as WebhookRetryData

      // SSRF check — a blocked/invalid URL throws: the job fails visibly
      // (and stops retrying via BullMQ's attempts) instead of a silent break.
      await assertSafeOutboundUrl(d.url)
      const host = loggableUrl(d.url)

      // Gli header (spesso un token del cliente) NON stanno nel job: si
      // rileggono dal passo che ha l'azione (revisione totale · E-11).
      const headers = await webhookRetryHeaders(d)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const res = await fetch(d.url, {
          method:  d.method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body:    d.method !== 'GET' ? d.payload : undefined,
          signal:  controller.signal,
          redirect: 'manual',   // its target was never checked (review of 23 Sep 2026)
        })
        // C-29: corpo della risposta scartato (connessione rilasciata subito).
        await res.body?.cancel().catch(() => undefined)
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        logger.info({ host, status: res.status, attempt: d.attempt }, '[webhook_retry] succeeded')
      } catch (err) {
        logger.error({ host, attempt: d.attempt, err }, '[webhook_retry] attempt failed')
        // BullMQ gestisce i retry automaticamente via attempts/backoff config
        throw err  // re-throw so BullMQ knows to retry
      } finally {
        clearTimeout(timer)
      }

      break
    }

    case 'trigger_timer': {
      const { triggerId, entityType } = job.data as unknown as { triggerId: string; entityType: string; entityId: string; tenantId: string }

      // 1. Load the trigger definition
      const session = getSession(undefined, 'WRITE')
      try {
        const triggerRows = await runQuery<{ props: Record<string, unknown> }>(session, `
          MATCH (t:AutoTrigger {id: $triggerId, tenant_id: $tenantId, enabled: true})
          RETURN properties(t) AS props
        `, { triggerId, tenantId })

        if (triggerRows.length === 0) {
          logger.info({ triggerId, entityId }, '[trigger_timer] trigger not found or disabled — skipped')
          break
        }

        const trigger = triggerRows[0].props

        // 2. Load the current entity (with relationships for assigned_to check)
        // Stessa lettura del consumatore degli eventi (lib/automationEntity.ts).
        const entity = await loadAutomationEntity(session, tenantId, entityType as AutomationEntityType, entityId)
        if (!entity) {
          logger.info({ entityId }, '[trigger_timer] entity not found — skipped')
          break
        }

        // 3. Evaluate conditions — they might no longer be true
        const conditions = parseConditions(trigger['conditions'] as string | null)

        if (!evaluateConditions(conditions, entity)) {
          logger.info({ triggerId, entityId, triggerName: trigger['name'] }, '[trigger_timer] conditions no longer met — skipped')
          break
        }

        // 4. Execute actions
        const actions = parseActions(trigger['actions'] as string | null)
        const execCtx: ActionExecutionContext = {
          tenantId, userId: AUTOMATION_ACTOR, entityId, entityType,
          entity, source: 'trigger', sourceName: trigger['name'] as string,
        }
        const results = await executeActions(actions, execCtx)

        // 5. Update execution count
        await runQuery(session, `
          MATCH (t:AutoTrigger {id: $triggerId, tenant_id: $tenantId})
          SET t.execution_count = coalesce(t.execution_count, 0) + 1,
              t.last_executed_at = $now
        `, { triggerId, tenantId, now: new Date().toISOString() })

        const successCount = results.filter(r => r.success).length
        const failed = results.find(r => !r.success)
        if (failed) {
          // Partial failure must be visible: the job fails (BullMQ retry
          // policy decides what happens next) instead of a green job that
          // silently ran zero actions.
          throw new Error(`[trigger_timer] action "${failed.action}" failed for trigger ${triggerId} on ${entityId}: ${failed.error ?? 'unknown error'} (${successCount}/${results.length} actions ran)`)
        }
        logger.info({ triggerId, entityId, triggerName: trigger['name'], actionsRun: successCount }, '[trigger_timer] executed')
      } finally {
        await session.close()
      }
      break
    }

    default:
      throw new Error(`[workflow-jobs] unknown job "${job.name}" (entityId=${entityId})`)
  }
}

// ── Notification jobs worker ──────────────────────────────────────────────────

async function processNotificationJob(job: Job): Promise<void> {
  switch (job.name) {
    case 'escalation_check': {
      // Revisione del 14 set 2026 · NT-8: prima questo ramo scriveva un log e
      // basta — la regola «escalation» si salvava e non notificava mai nessuno.
      const { incidentId, tenantId, ruleId } = job.data as { incidentId: string; tenantId: string; ruleId: string }
      const { runEscalationCheck } = await import('../lib/notificationEscalation.js')
      const outcome = await runEscalationCheck(tenantId, incidentId, ruleId)
      logger.info({ incidentId, ruleId, outcome }, '[notification-jobs] escalation_check')
      break
    }

    case 'timer_wait': {
      const { instanceId, toStep: scheduledToStep, tenantId } = job.data as { instanceId: string; toStep?: string; tenantId: string }
      const session = getSession(undefined, 'WRITE')
      try {
        // B-18: il passo di arrivo si risolve ORA, non quando il timer è
        // partito. Il job può aspettare ore o giorni, e in mezzo
        // l'amministratore può aver cambiato l'arco automatico in uscita dal
        // passo di attesa: il nome messo nel payload al momento dell'ingresso
        // puntava al vuoto e la transizione falliva (un solo tentativo, poi il
        // job resta nei falliti — nessuno lo vede). Si riparte dal passo dove
        // l'istanza si trova adesso.
        const fresh = await session.executeRead((tx) => tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})-[:CURRENT_STEP]->(cur:WorkflowStep)
          // L'innesco "timer" e' quello che un amministratore sceglie per primo
          // su un arco che esce da un'attesa, ed era inerte: nessun consumatore
          // lo percorreva (revisione · B-M-4). Adesso conclude l'attesa come
          // "automatic" — e' la stessa cosa, detta meglio.
          OPTIONAL MATCH (cur)-[tr:TRANSITIONS_TO]->(next:WorkflowStep)
            WHERE tr.trigger IN $exitTriggers
          WITH cur, next ORDER BY coalesce(next.step_order, 999), next.name
          RETURN cur.name AS currentStep, collect(next.name)[0] AS toStep
        `, { instanceId, tenantId, exitTriggers: [...WAIT_EXIT_TRIGGERS] }))
        if (fresh.records.length === 0) {
          throw new Error(`timer_wait: instance ${instanceId} of tenant ${tenantId} no longer exists or has no current step — the timer cannot complete`)
        }
        const currentStep = fresh.records[0]!.get('currentStep') as string
        const toStep      = fresh.records[0]!.get('toStep') as string | null
        if (!toStep) {
          throw new Error(
            `timer_wait: no transition with an "automatic" or "timer" trigger leaves step "${currentStep}", so the wait cannot complete ` +
            `(the edge was expected towards "${scheduledToStep ?? 'n/a'}" when the timer started). Add the edge in the designer.`,
          )
        }
        if (scheduledToStep && scheduledToStep !== toStep) {
          logger.warn({ instanceId, scheduledToStep, toStep, currentStep }, '[notification-jobs] timer_wait: il passo di arrivo è cambiato dopo la partenza del timer — si usa quello di adesso')
        }
        // The pipeline of the transitions (wave 7 · B1), with the guards of every
        // path. IL VARCO, anche a orologeria, is one of them: l'ondata 2 aveva
        // ALLARGATO questo match da `automatic` a `automatic|timer` senza
        // portarsi dietro il varco, e un arco `timer` verso il passo
        // programmato di una change era lo stesso scavalcamento, differito.
        const outcome = await transitionTicket(session, {
          tenantId, instanceId, toStep, actor: { kind: 'system', path: 'timer', userId: 'timer' }, triggerType: 'automatic',
        })
        if (!outcome.moved) {
          const { refusal } = outcome
          /**
           * RIFIUTATA DA UNA GUARDIA ≠ ANDATA STORTA (rimedio, 20 set 2026;
           * revisione totale · C-30). Rilanciando, BullMQ ritentava, i
           * tentativi si esaurivano e il ticket restava nel passo di attesa
           * per sempre senza un segnale: una guardia non dipende dal tempo che
           * passa ma da qualcuno che chiuda un compito o dia un'approvazione.
           * L'esito si scrive sull'esecuzione del passo, come fanno le
           * scadenze, così la diagnostica elenca il ticket fra quelli
           * bloccati; the pipeline notes it on the ticket. Only an error that
           * may be transient is thrown, for the queue to retry.
           */
          if (refusal.final) {
            await runQuery(session, `
              MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})-[:STEP_HISTORY]->(ex:WorkflowStepExecution)
              WHERE ex.exited_at IS NULL
              SET ex.deadline_outcome    = 'refused',
                  ex.deadline_reason     = $reason,
                  ex.deadline_detail     = $detail,
                  ex.deadline_to_step    = $toStep,
                  ex.deadline_checked_at = $now
            `, {
              instanceId, tenantId, toStep, reason: DEADLINE_REASON[refusal.guard],
              // Il dettaglio finisce sul nodo e lo legge la diagnostica: inglese, come tutti i testi dell'API.
              detail: `timer_wait: the automatic transition to "${toStep}" was refused (${refusal.guard}): ${refusal.message}`,
              now: new Date().toISOString(),
            })
            logger.warn({ instanceId, toStep, guard: refusal.guard, reason: refusal.message },
              '[notification-jobs] timer_wait refused: the ticket stays in the wait (shown in the diagnostics)')
            break
          }
          throw new Error(`timer_wait transition failed for instance ${instanceId} → ${toStep}: ${refusal.message}`)
        }
        logger.info({ instanceId, toStep }, '[notification-jobs] timer_wait transition completed')
      } finally {
        await session.close()
      }
      break
    }

    default:
      throw new Error(`[notification-jobs] unknown job "${job.name}"`)
  }
}


/** One worker per tenant on `notification-jobs@<tenant>` (23 Sep 2026). */
export function startNotificationJobWorker(): TenantWorkerPool<unknown, void> {
  return createTenantWorkers<unknown, void>(NOTIFICATION_JOBS_QUEUE, processNotificationJob, { concurrency: 3 })
}

/**
 * Enqueues a delayed escalation check in the tenant's queue. Awaited by the
 * caller: a failed enqueue (Redis down) must surface where the incident is
 * created, not vanish as an unhandled rejection (A-13).
 */
export async function scheduleEscalationCheck(incidentId: string, tenantId: string, ruleId: string, delayMinutes: number): Promise<void> {
  await getTenantQueue(NOTIFICATION_JOBS_QUEUE, tenantId).add(
    'escalation_check',
    { incidentId, tenantId, ruleId },
    { delay: delayMinutes * 60 * 1000, jobId: `escalation-${incidentId}-${ruleId}`, removeOnComplete: true },
  )
}

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * Le passate di un tenant, nella sua coda: scadenze dei passi, OLA e SLA ogni
 * minuto, ripresa delle transizioni automatiche ogni cinque. Job Scheduler
 * (BullMQ 6) con un'identità esplicita: `upsert` da ogni processo e a ogni
 * avvio non ne crea un secondo. La ripresa: il perché sta in
 * `lib/riprendiTransizioni.ts` — una change che perde la sua occasione restava
 * ferma per sempre.
 */
export async function scheduleWorkflowSweeps(queue: Queue, tenantId: string): Promise<void> {
  const opts = { removeOnComplete: true, removeOnFail: 100 }
  const data = (job: string) => ({ instanceId: '', entityId: '', tenantId, job })
  await queue.upsertJobScheduler('workflow-step-deadlines', { every: STEP_DEADLINES_EVERY_MS }, { name: STEP_DEADLINES_JOB, data: data(STEP_DEADLINES_JOB), opts })
  await queue.upsertJobScheduler('workflow-ola-sweep', { every: OLA_SWEEP_EVERY_MS }, { name: OLA_SWEEP_JOB, data: data(OLA_SWEEP_JOB), opts })
  await queue.upsertJobScheduler('workflow-sla-sweep', { every: SLA_SWEEP_EVERY_MS }, { name: SLA_SWEEP_JOB, data: data(SLA_SWEEP_JOB), opts })
  await queue.upsertJobScheduler('workflow-ripresa-transizioni', { every: RIPRESA_EVERY_MS }, { name: RIPRESA_JOB, data: data(RIPRESA_JOB), opts })
  await queue.upsertJobScheduler('workflow-outbox-resend', { every: OUTBOX_RESEND_EVERY_MS }, { name: OUTBOX_RESEND_JOB, data: data(OUTBOX_RESEND_JOB), opts })
}

/** One worker per tenant on `workflow-jobs@<tenant>`, each with its tenant's periodic sweeps (scheduleWorkflowSweeps). */
export function startWorkflowJobWorker(): TenantWorkerPool<WorkflowJobData> {
  return createTenantWorkers<WorkflowJobData>(WORKFLOW_JOBS_QUEUE, processWorkflowJob, {
    concurrency: 5,
    schedule: scheduleWorkflowSweeps,
    onFailed: (job, err) => {
      if (job?.name === 'webhook_retry' && (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)) {
        logger.error({
          jobName:  job.name,
          host:     loggableUrl(String((job.data as Record<string, unknown>)['url'] ?? '')),
          attempts: job.attemptsMade,
          err:      err.message,
        }, '[webhook_retry] all retries exhausted')
      }
    },
  })
}
