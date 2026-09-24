/**
 * LE SCADENZE DEI PASSI DI WORKFLOW (verifica «Cosa resta cablato», ondata 3).
 *
 * Esempio del proprietario: «se la change resta in review più di 7 giorni,
 * vai a closed e imposta esito = successful». La forma della scadenza è in
 * `@opengraphity/types` (`workflowDeadline.ts`); qui ci sono le tre cose che
 * hanno bisogno del grafo:
 *
 *  1. **La scrittura** (`stepDeadlineWrite.ts`). Una scadenza si salva solo se ha senso nel suo
 *     workflow: l'arco verso il passo di arrivo esiste, il calendario esiste, i
 *     campi sono del metamodello e i valori del vocabolario, e — per le change —
 *     non porta verso un passo protetto dalle approvazioni né esce da un passo
 *     di approvazione. Il controllo gira sulla definizione INTERA dopo ogni
 *     modifica che può romperlo (togliere un arco, un passo, cambiare uno
 *     scopo), nella stessa transazione: se rompe, non si scrive.
 *
 *  2. **Lo scatto.** Una passata ogni minuto (`runStepDeadlineSweep`) cerca i
 *     ticket fermi in un passo con scadenza e calcola quando scade — dall'ora
 *     di ingresso nel passo, con il calendario scelto. Non un job per ingresso:
 *     così vale anche per il passo iniziale (l'istanza nasce dentro la
 *     transazione di chi crea il ticket), una scadenza cambiata vale per chi è
 *     già nel passo, e se Redis perde un job non si perde una chiusura.
 *
 *  3. **L'esito**, scritto sull'esecuzione del passo: `moved`, oppure
 *     `refused` (il varco delle approvazioni) o `failed` (configurazione rotta
 *     fra il salvataggio e lo scatto). Un rifiuto o un guasto si riprova ogni
 *     ora — le approvazioni possono arrivare, l'arco può essere rimesso — ma
 *     si scrive a voce alta solo la prima volta, e la diagnostica lo mostra.
 */
import type { Session } from 'neo4j-driver'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { checkTicketTransition, transitionTicket, type TicketTransitionRequest, type TransitionGuard } from '../services/ticketTransition.js'
import { calculateDeadline, getServiceCalendarById, getTenantTimezone, minutesOfDay, type ServiceCalendar } from '@opengraphity/sla'
import {
  AUTOMATION_ACTOR, STEP_DEADLINE_ACTOR, parseStepDeadline, stepDeadlineMinutes,
  type AutomationEntityType, type StepDeadline,
} from '@opengraphity/types'
import { logger } from './logger.js'
import { assertStepFieldValue, stepFieldMetas } from './stepFieldWrites.js'
import { stepDeadlineOutcomesTotal } from '../middleware/metrics.js'

const log = logger.child({ module: 'step-deadlines' })

/** Ogni quanto si riprova una scadenza rifiutata o fallita. */
export const STEP_DEADLINE_RETRY_MS = 60 * 60 * 1000
/** Una scadenza «in corso» da più di così è di una passata morta a metà: si riprende. */
const STALE_RUNNING_MS = 10 * 60 * 1000

const LABELS: Readonly<Record<string, string>> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest', kb_article: 'KBArticle',
}

// ── 2. Quando scade ───────────────────────────────────────────────────────────

/**
 * L'istante in cui scade: dall'ingresso nel passo, 24×7 o con il calendario.
 * Con un calendario un giorno è una giornata di servizio intera (da inizio a
 * fine fascia), così «2 giorni» con un calendario 9–18 non diventa 4 giorni e
 * mezzo di orologio.
 */
export function stepDeadlineDueAt(enteredAt: Date, deadline: StepDeadline, timezone: string, calendar: ServiceCalendar | null): Date {
  if (!calendar) return new Date(enteredAt.getTime() + stepDeadlineMinutes(deadline, null) * 60_000)
  const perDay = minutesOfDay(calendar.end) - minutesOfDay(calendar.start)
  return calculateDeadline(enteredAt, stepDeadlineMinutes(deadline, perDay), true, timezone, calendar)
}

// ── 3. Lo scatto ──────────────────────────────────────────────────────────────

export type StepDeadlineOutcome = 'moved' | 'refused' | 'failed' | 'skipped'

export interface StepDeadlineCandidate {
  tenantId:   string
  instanceId: string
  entityId:   string
  entityType: string
  stepName:   string
  execId:     string
  enteredAt:  string
  deadline:   string
  /** L'esito precedente: `null` alla prima prova. Serve a non ripetere l'allarme ogni ora. */
  previousOutcome: string | null
}

export interface SweepSummary { candidates: number; moved: number; refused: number; failed: number; notDue: number }

/** I ticket fermi in un passo con scadenza, di tutti i clienti. */
export async function stepDeadlineCandidates(session: Session, tenantId: string, now: Date): Promise<StepDeadlineCandidate[]> {
  // The tenant's steps only: the sweep runs in the tenant's own queue (23 Sep 2026).
  const rows = await runQuery<Record<string, unknown>>(session, `
    MATCH (s:WorkflowStep {tenant_id: $tenantId}) WHERE s.deadline IS NOT NULL
    MATCH (wi:WorkflowInstance {tenant_id: $tenantId})-[:CURRENT_STEP]->(s)
    MATCH (wi)-[:STEP_HISTORY]->(ex:WorkflowStepExecution)
    WHERE ex.exited_at IS NULL AND ex.step_name = s.name
      AND (ex.deadline_outcome IS NULL
           OR (ex.deadline_outcome IN ['refused', 'failed'] AND ex.deadline_retry_at <= $now)
           OR (ex.deadline_outcome = 'running' AND ex.deadline_checked_at <= $staleBefore))
    RETURN wi.tenant_id AS tenantId, wi.id AS instanceId, wi.entity_id AS entityId, wi.entity_type AS entityType,
           s.name AS stepName, s.deadline AS deadline, ex.id AS execId, ex.entered_at AS enteredAt,
           ex.deadline_outcome AS previousOutcome
  `, { tenantId, now: now.toISOString(), staleBefore: new Date(now.getTime() - STALE_RUNNING_MS).toISOString() })
  return rows.map((r) => ({
    tenantId: r['tenantId'] as string, instanceId: r['instanceId'] as string, entityId: r['entityId'] as string,
    entityType: r['entityType'] as string, stepName: r['stepName'] as string, deadline: r['deadline'] as string,
    execId: r['execId'] as string, enteredAt: r['enteredAt'] as string,
    previousOutcome: (r['previousOutcome'] ?? null) as string | null,
  }))
}

/** La passata di un tenant: una volta al minuto, dal job `step_deadlines` della sua coda `workflow-jobs@<tenant>`. */
export async function runStepDeadlineSweep(tenantId: string, now = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = { candidates: 0, moved: 0, refused: 0, failed: 0, notDue: 0 }
  const readSession = getSession(undefined, 'READ')
  let candidates: StepDeadlineCandidate[]
  try {
    candidates = await stepDeadlineCandidates(readSession, tenantId, now)
  } finally {
    await readSession.close()
  }
  summary.candidates = candidates.length

  const timezones = new Map<string, Promise<string>>()
  const calendars = new Map<string, Promise<ServiceCalendar>>()
  for (const c of candidates) {
    let deadline: StepDeadline | null
    let due: Date
    try {
      deadline = parseStepDeadline(c.deadline)
      if (!deadline) continue
      let calendar: ServiceCalendar | null = null
      let timezone = 'UTC'
      if (deadline.calendar_id) {
        const key = `${c.tenantId}/${deadline.calendar_id}`
        if (!calendars.has(key)) calendars.set(key, getServiceCalendarById(c.tenantId, deadline.calendar_id))
        if (!timezones.has(c.tenantId)) timezones.set(c.tenantId, getTenantTimezone(c.tenantId))
        /**
         * Entrambe le promesse si attendono INSIEME (revisione totale · C-14):
         * prima si attendeva la prima e poi la seconda, quindi se la prima
         * rifiutava la seconda restava senza gestore — `unhandledRejection`,
         * che da Node 15 termina il processo. Un Neo4j in pausa durante una
         * passata con scadenze a calendario faceva cadere il worker invece di
         * contare la scadenza come «failed».
         */
        const [cal, tz] = await Promise.all([calendars.get(key)!, timezones.get(c.tenantId)!])
        calendar = cal
        timezone = tz
      }
      due = stepDeadlineDueAt(new Date(c.enteredAt), deadline, timezone, calendar)
    } catch (e) {
      await recordOutcome(c, 'failed', 'config', e instanceof Error ? e.message : String(e), null, now)
      summary.failed++
      continue
    }
    if (due.getTime() > now.getTime()) { summary.notDue++; continue }
    const outcome = await fireStepDeadline(c, now)
    if (outcome === 'moved') summary.moved++
    else if (outcome === 'refused') summary.refused++
    else if (outcome === 'failed') summary.failed++
  }
  return summary
}

/** Scrive l'esito sull'esecuzione del passo, lo conta e lo dice (a voce alta solo la prima volta). */
async function recordOutcome(
  c: StepDeadlineCandidate, outcome: Exclude<StepDeadlineOutcome, 'skipped'>, reason: string, detail: string | null,
  toStep: string | null, now: Date,
): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, `
      MATCH (ex:WorkflowStepExecution {id: $execId, tenant_id: $tenantId})
      SET ex.deadline_outcome  = $outcome,
          ex.deadline_reason   = $reason,
          ex.deadline_detail   = $detail,
          ex.deadline_to_step  = $toStep,
          ex.deadline_checked_at = $now,
          ex.deadline_retry_at = $retryAt
    `, {
      execId: c.execId, tenantId: c.tenantId, outcome, reason, detail, toStep, now: now.toISOString(),
      retryAt: outcome === 'moved' ? null : new Date(now.getTime() + STEP_DEADLINE_RETRY_MS).toISOString(),
    })
  } finally {
    await session.close()
  }
  stepDeadlineOutcomesTotal.inc({ outcome, reason })
  const fields = { tenantId: c.tenantId, entityType: c.entityType, entityId: c.entityId, step: c.stepName, toStep, reason, detail }
  if (outcome === 'moved') log.info(fields, '[step-deadline] ticket spostato dalla scadenza del passo')
  else if (c.previousOutcome === outcome) log.debug(fields, `[step-deadline] ancora ${outcome}: si riprova fra un'ora`)
  else if (outcome === 'refused') log.warn(fields, '[step-deadline] scadenza rifiutata: il ticket resta nel passo, si riprova ogni ora')
  else log.error(fields, '[step-deadline] scadenza non eseguita: configurazione da correggere, si riprova ogni ora')
}

/**
 * The reason a deadline records for each guard that holds the ticket: the
 * three the deadline checked on its own keep their names (the diagnostics
 * show them), the rest are the guards it gained with the pipeline.
 */
export const DEADLINE_REASON: Readonly<Record<TransitionGuard, string>> = {
  change_window:    'approval_gate',
  request_approval: 'request_approval',
  own_approval:     'own_approval',
  named_approval:   'approval_request',
  required_fields:  'required_fields',
  step_metadata:    'step_metadata',
  type_permission:  'type_permission',
  workflow:         'transition',
}

/** Sposta UN ticket. Prende la scadenza in carico prima di toccarlo, così due passate non la eseguono due volte. */
export async function fireStepDeadline(c: StepDeadlineCandidate, now: Date): Promise<StepDeadlineOutcome> {
  const session = getSession(undefined, 'WRITE')
  let toStep: string | null = null
  try {
    const claimed = await runQueryOne<{ id: string }>(session, `
      MATCH (ex:WorkflowStepExecution {id: $execId, tenant_id: $tenantId})
      WHERE ex.exited_at IS NULL
        AND (ex.deadline_outcome IS NULL
             OR (ex.deadline_outcome IN ['refused', 'failed'] AND ex.deadline_retry_at <= $now)
             OR (ex.deadline_outcome = 'running' AND ex.deadline_checked_at <= $staleBefore))
      SET ex.deadline_outcome = 'running', ex.deadline_checked_at = $now
      RETURN ex.id AS id
    `, { execId: c.execId, tenantId: c.tenantId, now: now.toISOString(), staleBefore: new Date(now.getTime() - STALE_RUNNING_MS).toISOString() })
    if (!claimed) return 'skipped'

    // Tutto si rilegge ADESSO: la scadenza, l'arco e il passo di arrivo. In
    // mezzo l'amministratore può aver cambiato il workflow.
    const label = LABELS[c.entityType]
    const state = await runQueryOne<Record<string, unknown>>(session, `
      MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})-[:CURRENT_STEP]->(cur:WorkflowStep)
      OPTIONAL MATCH (e)-[:HAS_WORKFLOW]->(wi)
      OPTIONAL MATCH (e)-[:ASSIGNED_TO]->(assignee)
      OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(team)
      RETURN cur.name AS currentStep, cur.deadline AS deadline, properties(e) AS entity,
             assignee.id AS assignedTo, team.id AS assignedTeam
    `, { instanceId: c.instanceId, tenantId: c.tenantId })
    if (!state || state['currentStep'] !== c.stepName || !label) {
      await releaseClaim(session, c)
      return 'skipped'
    }
    const deadline = parseStepDeadline(state['deadline'])
    if (!deadline) {
      await releaseClaim(session, c)   // la scadenza è stata tolta mentre la passata girava
      return 'skipped'
    }
    toStep = deadline.to_step

    const arc = await runQueryOne<{ name: string }>(session, `
      MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})-[:CURRENT_STEP]->(cur:WorkflowStep)
      // tenant-ok(traversal): il passo di arrivo è un vicino del passo corrente dell'istanza scopata
      MATCH (cur)-[:TRANSITIONS_TO]->(to:WorkflowStep {name: $toStep, definition_id: cur.definition_id})
      RETURN to.name AS name
    `, { instanceId: c.instanceId, tenantId: c.tenantId, toStep })
    if (!arc) {
      await recordOutcome(c, 'failed', 'no_arc', `no arc from "${c.stepName}" to "${toStep}"`, toStep, now)
      return 'failed'
    }

    // Every guard of a move is the pipeline's (services/ticketTransition.ts,
    // wave 7 · B1): the release window of a change, the approvals, the
    // required fields and the metadata of the step. Checked BEFORE the fields
    // of the deadline are written: a move that will be refused must not
    // leave them written.
    const request: TicketTransitionRequest = {
      tenantId: c.tenantId, instanceId: c.instanceId, toStep, triggerType: 'timer',
      actor: { kind: 'system', path: 'step_deadline', userId: STEP_DEADLINE_ACTOR },
    }
    const held = await checkTicketTransition(session, request)
    if (held) {
      await recordOutcome(c, 'refused', DEADLINE_REASON[held.guard], held.guard === 'workflow' ? held.message : null, toStep, now)
      return 'refused'
    }

    // I campi si validano PRIMA di spostare: un valore uscito dal vocabolario
    // non deve lasciare il ticket spostato a metà.
    const metas = await stepFieldMetas(session, c.tenantId, c.entityType)
    let values: { field: string; value: string | number | boolean }[]
    try {
      values = deadline.set_fields.map((f) => ({
        field: f.field,
        value: assertStepFieldValue(metas, c.entityType, f.field, f.value, `deadline of step "${c.stepName}"`, { allowTemplate: false }),
      }))
    } catch (e) {
      await recordOutcome(c, 'failed', 'field', e instanceof Error ? e.message : String(e), toStep, now)
      return 'failed'
    }

    const { writeTicketField } = await import('./ticketFieldWrite.js')

    /**
     * I campi della scadenza si scrivono PRIMA di spostare (revisione totale ·
     * C-13). Prima si scrivevano dopo, fuori dalla transazione della
     * transizione: una scrittura fallita (un vincolo, un blip del database)
     * lasciava il ticket già spostato, `recordOutcome('failed')` finiva su
     * un'esecuzione con `exited_at` — quindi mai ritentata e INVISIBILE nella
     * diagnostica, che guarda solo le esecuzioni aperte. Restava un log.
     *
     * Nell'ordine nuovo un errore lascia il ticket dov'è, l'esito «failed» su
     * un'esecuzione ancora aperta, e la passata dopo un'ora riprova. I valori
     * scritti entrano anche in `entityData`, così le condizioni della
     * transizione vedono lo stato che il cliente ha chiesto.
     */
    const writtenFields: Record<string, unknown> = {}
    try {
      for (const { field, value } of values) {
        const written = await writeTicketField(session, c.tenantId, c.entityType, c.entityId, field, value)
        writtenFields[field] = value
        if (c.entityType !== 'change' && c.entityType !== 'kb_article') {
          const { publishTicketUpdated } = await import('./ticketUpdated.js')
          await publishTicketUpdated({ tenantId: c.tenantId, userId: AUTOMATION_ACTOR }, c.entityType as AutomationEntityType, c.entityId, written.before, written.after)
        }
      }
    } catch (e) {
      await recordOutcome(c, 'failed', 'field_write', e instanceof Error ? e.message : String(e), toStep, now)
      return 'failed'
    }

    const outcome = await transitionTicket(session, { ...request, extraEntityData: writtenFields })
    if (!outcome.moved) {
      // The engine's no (the arc's condition) or a guard that changed in the
      // meantime: the ticket stays, the pass retries in an hour.
      await recordOutcome(c, outcome.refusal.guard === 'workflow' ? 'failed' : 'refused',
        outcome.refusal.guard === 'workflow' ? 'transition' : DEADLINE_REASON[outcome.refusal.guard], outcome.refusal.message, toStep, now)
      return outcome.refusal.guard === 'workflow' ? 'failed' : 'refused'
    }

    await recordOutcome(c, 'moved', 'deadline', null, toStep, now)
    const { audit } = await import('./audit.js')
    // La voce d'audit vuole anche l'e-mail: una scadenza non ne ha, e lo dice (come le automazioni).
    void audit({ tenantId: c.tenantId, userId: AUTOMATION_ACTOR, userEmail: AUTOMATION_ACTOR, role: 'system' } as never, 'workflow.step_deadline_moved', label, c.entityId, {
      fromStep: c.stepName, toStep, after: deadline.after, unit: deadline.unit, calendarId: deadline.calendar_id,
      setFields: deadline.set_fields,
    })
    return 'moved'
  } catch (e) {
    await recordOutcome(c, 'failed', 'error', e instanceof Error ? e.message : String(e), toStep, now)
    return 'failed'
  } finally {
    await session.close()
  }
}

async function releaseClaim(session: Session, c: StepDeadlineCandidate): Promise<void> {
  await runQuery(session, `
    MATCH (ex:WorkflowStepExecution {id: $execId, tenant_id: $tenantId})
    WHERE ex.deadline_outcome = 'running'
    SET ex.deadline_outcome = $previous
  `, { execId: c.execId, tenantId: c.tenantId, previous: c.previousOutcome === 'running' ? null : c.previousOutcome })
}
