import { BaseConsumer } from '@opengraphity/events'
import type { DomainEvent, WorkflowStepEnteredPayload } from '@opengraphity/types'
import { WORKFLOW_STEP_ENTERED_EVENT, TICKET_TEAM_ASSIGNED_EVENT, type TicketTeamAssignedPayload } from '@opengraphity/types'
import type {
  IncidentCreatedPayload,
  IncidentResolvedPayload,
  RequestCreatedPayload,
  RequestCompletedPayload,
  ProblemCreatedPayload,
  ProblemResolvedPayload,
} from '@opengraphity/types'
import type { SLAPolicy } from './policy.js'
import { selectSLAForEntity } from './selector.js'
import {
  createSLAStatus, markResponseMet, getSLAStatus, markResolveMet, pauseSLA, resumeSLA, reopenSLA, repolicySLA, getEntityPriority, type SLAStatus,
  getEntityCreatedAt, getEntityScope, type SLAPauseType,
} from './status.js'
import {
  initScheduler,
  scheduleWarning,
  scheduleBreachCheck,
  scheduleResponseCheck,
  cancelSLAJobs,
} from './scheduler.js'
import { calendarFor } from './calendar.js'

/** L'istante di un evento; il suo timestamp se valido, altrimenti adesso. */
function eventInstant(event: DomainEvent<unknown>): Date {
  const d = new Date(event.timestamp)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

/**
 * La policy SLA del tenant per un'entità, o null se nessuna corrisponde.
 *
 * Null vuol dire NESSUNO SLA. Prima qui c'era il ripiego sulle policy di
 * fabbrica scritte nel codice, applicate anche a un tenant con le sue policy
 * quando nessuna copriva il ticket: invisibili nella pagina SLA Policies e non
 * modificabili. Una policy del tenant corrotta lancia (il selettore è
 * fail-fast) e fa fallire il job.
 */
async function resolvePolicy(
  tenantId:   string,
  entityType: 'incident' | 'change' | 'service_request' | 'problem',
  severity:   string,
  entityId:   string,
): Promise<SLAPolicy | null> {
  // Categoria e team dell'entità: senza di essi il selettore poteva scegliere
  // solo fra «priorità sola» e «tutto», e ogni policy con una categoria o un
  // team era codice morto — pur essendo offerta dalla pagina.
  const { category, teamId } = await getEntityScope(tenantId, entityId)
  const tenantPolicy = await selectSLAForEntity(tenantId, entityType, severity, category, teamId)
  if (tenantPolicy) {
    // Adapt the flat per-priority record to the tiered SLAPolicy shape used
    // by createSLAStatus: one tier matching the entity's severity.
    return {
      id:          tenantPolicy.id,
      tenant_id:   tenantId,
      name:        tenantPolicy.name,
      entity_type: entityType,
      timezone:    tenantPolicy.timezone,
      // L'orario di servizio è il calendario scelto dalla policy (ondata 2).
      // Si legge solo se serve: una policy 24x7 non dipende da un calendario.
      calendar:    await calendarFor(tenantId, { name: tenantPolicy.name, businessHours: tenantPolicy.business_hours, calendarId: tenantPolicy.calendar_id }),
      tiers: [{
        severity,
        response_minutes: tenantPolicy.response_minutes,
        resolve_minutes:  tenantPolicy.resolve_minutes,
        business_hours:   tenantPolicy.business_hours,
        warning_minutes:  tenantPolicy.warning_minutes,
      }],
    }
  }
  return null
}

export class SLAEngine extends BaseConsumer<unknown> {
  constructor() {
    super('sla-engine')
  }

  async process(event: DomainEvent<unknown>): Promise<void> {
    switch (event.type) {
      case 'incident.created':
        await this.handleEntityCreated(
          event as DomainEvent<IncidentCreatedPayload>,
          'incident',
          (p) => (p as IncidentCreatedPayload).severity,
        )
        break

      case 'incident.resolved':
        await this.handleEntityResolved(
          event as DomainEvent<IncidentResolvedPayload>,
          'incident',
        )
        break

      // First assignment = first response → satisfies the SLA response target.
      case 'incident.assigned':
        await this.handleEntityResponded(event, 'incident')
        break

      // A 'pending'/waiting step's enter/exit actions (sla_pause / sla_resume)
      // publish these. Entering the waiting step stops the SLA clock; leaving
      // it restarts the clock, extending the deadlines by the paused duration.
      // Previously these events had NO consumer — the clock never actually
      // stopped. sla_stop is treated as a pause (freeze) here.
      case 'sla.resolve.pause':
      case 'sla.resolve.stop':
        await this.handleSLAPause(event, 'resolve')
        break
      case 'sla.response.pause':
        await this.handleSLAPause(event, 'response')
        break

      case 'sla.resolve.resume':
      case 'sla.response.resume':
        await this.handleSLAResume(event)
        break

      // Le azioni di passo «avvia SLA» e «ferma SLA» (revisione del 14 set
      // 2026 · WA-1): il disegnatore le offre e i seed le usano, ma
      // `sla.<tipo>.start` e `sla.response.stop` non avevano nessun ramo qui —
      // l'azione risultava eseguita e non cambiava niente.
      case 'sla.resolve.start':
      case 'sla.response.start':
        await this.handleSLAStart(event)
        break
      case 'sla.response.stop':
        await this.handleEntityResponded(event, 'sla.response.stop')
        break

      case 'request.created':
        await this.handleEntityCreated(
          event as DomainEvent<RequestCreatedPayload>,
          'service_request',
          (p) => (p as RequestCreatedPayload).priority,
        )
        break

      case 'request.completed':
        await this.handleEntityResolved(
          event as DomainEvent<RequestCompletedPayload>,
          'service_request',
        )
        break

      case 'problem.created':
        await this.handleEntityCreated(
          event as DomainEvent<ProblemCreatedPayload>,
          'problem',
          (p) => (p as ProblemCreatedPayload).priority,
        )
        break

      case 'problem.resolved':
        await this.handleEntityResolved(
          event as DomainEvent<ProblemResolvedPayload>,
          'problem',
        )
        break

      case TICKET_TEAM_ASSIGNED_EVENT:
        await this.handleTeamAssigned(event as DomainEvent<TicketTeamAssignedPayload>)
        break

      // Ogni transizione del motore di workflow, da qualunque cammino: prima
      // presa in carico e conclusione del ticket (vedi handleStepEntered).
      case WORKFLOW_STEP_ENTERED_EVENT:
        await this.handleStepEntered(event as DomainEvent<WorkflowStepEnteredPayload>)
        break

      default:
        console.log(`[sla:engine] Event "${event.type}" — no SLA rule, skipping`)
    }
  }

  private async handleEntityCreated(
    event: DomainEvent<{ id: string }>,
    entityType: 'incident' | 'change' | 'service_request' | 'problem',
    getSeverity: (payload: unknown) => string,
  ): Promise<void> {
    const payload  = event.payload

    // The SLA clock starts at the entity's created_at, not at consumer
    // processing time (a retried job must not push the deadlines forward).
    // The payload may carry created_at; otherwise read it from the node.
    const payloadCreatedAt = (payload as { created_at?: unknown }).created_at
    const startedAt = typeof payloadCreatedAt === 'string' && !Number.isNaN(new Date(payloadCreatedAt).getTime())
      ? new Date(payloadCreatedAt)
      : await getEntityCreatedAt(event.tenant_id, payload.id)
    // I controlli OLA/UC non si armano più qui: li fa la passata ogni minuto
    // dell'API (lib/olaSweep.ts), sul tempo in cui il ticket è del team.

    const severity = getSeverity(payload)
    await this.startSLA(event.tenant_id, entityType, payload.id, severity, startedAt)
  }

  /** Sceglie la policy, crea lo stato e programma i controlli. `null` se nessuna policy copre il ticket. */
  private async startSLA(
    tenantId: string,
    entityType: 'incident' | 'change' | 'service_request' | 'problem',
    entityId: string,
    severity: unknown,
    startedAt: Date,
  ): Promise<SLAStatus | null> {
    if (typeof severity !== 'string' || severity === '') {
      // Senza priorità non c'è policy da scegliere: nessuno SLA, e si dice.
      console.error(`[sla:engine] No SLA tier for ${entityType} severity="${String(severity)}" — NO SLA CREATED for ${entityId}`)
      return null
    }

    const policy = await resolvePolicy(tenantId, entityType, severity, entityId)
    if (!policy) {
      // Nessuna policy del tenant copre il ticket: nessuno SLA. Non è un
      // errore del job — è configurazione, e la diagnostica conta questi ticket.
      console.warn(`[sla:engine] No SLA policy matches ${entityType} ${entityId} (severity="${severity}") — NO SLA CREATED`)
      return null
    }

    const tier = policy.tiers.find((t) => t.severity === severity)
    if (!tier) {
      console.error(
        `[sla:engine] No SLA tier for ${entityType} severity="${severity}" (policy "${policy.name}") — NO SLA CREATED for ${entityId}`,
      )
      return null
    }

    const status = await createSLAStatus({ tenantId, entityId, entityType, severity, policy, startedAt })

    await Promise.all([
      scheduleWarning(status),
      scheduleBreachCheck(status),
      scheduleResponseCheck(status),
    ])

    console.log(
      `[sla:engine] SLA started for ${entityType} ${entityId}: ` +
        `response by ${status.response_deadline}, resolve by ${status.resolve_deadline}`,
    )
    return status
  }

  private eventEntityId(event: DomainEvent<unknown>): string {
    const p = event.payload as { id?: string; entity_id?: string }
    const id = p.id ?? p.entity_id
    if (!id) throw new Error(`${event.type} event missing entity id`)
    return id
  }

  /**
   * «Avvia SLA» all'ingresso in un passo:
   *  - lo SLA c'è ed è in pausa → riprende (come `sla_resume`);
   *  - lo SLA c'è e corre → niente da fare, l'orologio è già partito;
   *  - lo SLA non c'è (nessuna policy alla creazione, per esempio perché la
   *    policy dipende dal team e il team è arrivato dopo) → si sceglie la policy
   *    adesso e l'orologio parte adesso.
   */
  private async handleSLAStart(event: DomainEvent<unknown>): Promise<void> {
    const p = event.payload as { entity_id?: string; entity_type?: string }
    const entityId = this.eventEntityId(event)
    const status = await getSLAStatus(event.tenant_id, entityId)
    if (status?.paused_at) {
      await this.handleSLAResume(event)
      return
    }
    if (status) {
      console.log(`[sla:engine] ${event.type}: SLA already running for ${entityId} — nothing to start`)
      return
    }
    const entityType = p.entity_type
    if (entityType !== 'incident' && entityType !== 'problem' && entityType !== 'service_request') {
      console.log(`[sla:engine] ${event.type}: ${String(entityType)} has no SLA — nothing to start`)
      return
    }
    const severity = await getEntityPriority(event.tenant_id, entityType, entityId)
    const started = new Date(event.timestamp)
    await this.startSLA(event.tenant_id, entityType, entityId, severity, Number.isNaN(started.getTime()) ? new Date() : started)
  }

  /**
   * SL-10: il ticket ha un gruppo — la policy più specifica può essere
   * cambiata (una policy «per team»). Si riseleziona; se è un'altra, lo SLA in
   * corso passa a quella, e i controlli si riprogrammano sulle scadenze nuove.
   * Senza SLA (nessuna policy alla creazione) lo si avvia adesso.
   */
  private async handleTeamAssigned(event: DomainEvent<TicketTeamAssignedPayload>): Promise<void> {
    const p = event.payload
    if (p.entity_type !== 'incident' && p.entity_type !== 'problem' && p.entity_type !== 'service_request') return
    const severity = await getEntityPriority(event.tenant_id, p.entity_type, p.entity_id)
    if (typeof severity !== 'string' || severity === '') return
    const status = await getSLAStatus(event.tenant_id, p.entity_id)
    if (!status) {
      await this.startSLA(event.tenant_id, p.entity_type, p.entity_id, severity, await getEntityCreatedAt(event.tenant_id, p.entity_id))
      return
    }
    if (status.resolved_at || !status.policy_id) return
    const policy = await resolvePolicy(event.tenant_id, p.entity_type, severity, p.entity_id)
    if (!policy || policy.id === status.policy_id) return
    const updated = await repolicySLA(event.tenant_id, p.entity_id, policy, severity)
    if (!updated) return
    if (!updated.paused_at) {
      if (!updated.response_met) await scheduleResponseCheck(updated)
      if (!updated.breached) { await scheduleWarning(updated); await scheduleBreachCheck(updated) }
    }
    console.log(`[sla:engine] SLA of ${p.entity_type} ${p.entity_id} moved to policy "${policy.name}" after team assignment: resolve by ${updated.resolve_deadline}`)
  }

  private async handleSLAPause(event: DomainEvent<unknown>, slaType: SLAPauseType): Promise<void> {
    const entityId = this.eventEntityId(event)
    const paused = await pauseSLA(event.tenant_id, entityId, slaType, eventInstant(event))
    if (paused) {
      // Stop only the paused clock's timers — they are re-created on resume.
      await cancelSLAJobs(entityId, slaType)
      console.log(`[sla:engine] SLA paused (${slaType}) for ${entityId}`)
    }
  }

  private async handleSLAResume(event: DomainEvent<unknown>): Promise<void> {
    const entityId = this.eventEntityId(event)
    const resumed = await resumeSLA(event.tenant_id, entityId, eventInstant(event))
    if (!resumed) return
    const pausedType = (resumed.paused_type ?? 'both') as SLAPauseType
    // Re-schedule only the clock(s) that were paused, skipping met targets.
    // `response_breach_notified_at`: l'avviso della presa in carico è già
    // uscito, e non se ne manda un secondo alla ripresa (revisione totale ·
    // E-12 — `scheduleResponseCheck` con una scadenza passata usa
    // `Math.max(delay, 0)`, quindi scattava subito).
    if ((pausedType === 'response' || pausedType === 'both') && !resumed.response_met && !resumed.response_breach_notified_at) {
      await scheduleResponseCheck(resumed)
    }
    if ((pausedType === 'resolve' || pausedType === 'both') && !resumed.resolve_met) {
      await scheduleWarning(resumed)
      await scheduleBreachCheck(resumed)
    }
    console.log(
      `[sla:engine] SLA resumed (${pausedType}) for ${entityId}: ` +
        `response by ${resumed.response_deadline}, resolve by ${resumed.resolve_deadline}`,
    )
  }

  private async handleEntityResponded(event: DomainEvent<unknown>, entityType: string): Promise<void> {
    const entityId = (event.payload as { id?: string; entity_id?: string }).id
      ?? (event.payload as { entity_id?: string }).entity_id
    if (!entityId) throw new Error(`${entityType}.assigned event missing entity id`)
    await markResponseMet(event.tenant_id, entityId)
    // The response target is met: the pending response-breach timer must not
    // fire a false "response breach" warning (D-01).
    await cancelSLAJobs(entityId, 'response')
  }

  /**
   * Instant the entity was resolved: the resolved/completed events carry it
   * (`resolved_at` / `completed_at`); the event timestamp is the documented
   * fallback for the ones that do not.
   */
  private resolvedInstant(event: DomainEvent<unknown>): Date {
    const p = event.payload as { resolved_at?: unknown; completed_at?: unknown }
    const raw = p.resolved_at ?? p.completed_at ?? event.timestamp
    const d = new Date(raw as string)
    if (Number.isNaN(d.getTime())) {
      throw new Error(`[sla:engine] ${event.type}: resolved_at/completed_at/timestamp is not a valid instant (${JSON.stringify(raw)})`)
    }
    return d
  }

  /**
   * L'ingresso di un ticket in un passo, per OGNI cammino (manuale, automatico,
   * da change, da regola, da timer).
   *
   *  - Lasciare il passo iniziale è la prima presa in carico: la risposta è data.
   *  - Entrare in un passo di categoria `resolved`, o terminale, conclude il
   *    ticket: lo SLA si chiude, rispettato o no, all'istante dell'ingresso.
   *
   * Prima la risposta la segnava solo `incident.assigned` e la chiusura solo
   * `incident.resolved` / `problem.resolved` / `request.completed`, che molti
   * cammini non pubblicano: un problem risolto dalla sua change e una
   * richiesta chiusa dal workflow restavano con lo SLA aperto per sempre, e la
   * violazione sarebbe scattata su un ticket concluso (giro del 14 set 2026).
   * Idempotente: una risposta o una conclusione già registrata non si riscrive
   * (un «chiuso» dopo un «risolto» non sposta la data né l'esito).
   */
  private async handleStepEntered(event: DomainEvent<WorkflowStepEnteredPayload>): Promise<void> {
    const p = event.payload
    if (!['incident', 'problem', 'service_request'].includes(p.entity_type)) return
    if (!p.entity_id) throw new Error(`[sla:engine] ${event.type} payload has no entity_id`)
    const status = await getSLAStatus(event.tenant_id, p.entity_id)
    if (!status) return

    if (p.from_initial && !status.response_met) {
      await markResponseMet(event.tenant_id, p.entity_id)
      await cancelSLAJobs(p.entity_id, 'response')
      console.log(`[sla:engine] Response met for ${p.entity_type} ${p.entity_id} (left the initial step "${p.from_step}")`)
    }

    const concludes = p.step_category === 'resolved' || p.step_terminal === true
    const enteredAt = new Date(p.entered_at)

    // F4 (revisione del 14 set 2026): la pausa segue la CATEGORIA del passo,
    // che è dato del cliente. Prima pausa e ripresa esistevano solo come azioni
    // sui passi di attesa del seed degli incident: un problem o una richiesta
    // fermi in un passo «in attesa» consumavano SLA come se ci si lavorasse.
    // Entrare in un passo `waiting` ferma l'orologio; entrare in un passo aperto
    // non di attesa lo fa ripartire. Le azioni esplicite restano e sono
    // compatibili (pausa e ripresa sono idempotenti).
    if (!Number.isNaN(enteredAt.getTime()) && !status.resolved_at) {
      if (p.step_category === 'waiting' && !status.paused_at) {
        const paused = await pauseSLA(event.tenant_id, p.entity_id, 'both', enteredAt)
        if (paused) {
          await cancelSLAJobs(p.entity_id, 'both')
          console.log(`[sla:engine] SLA paused for ${p.entity_type} ${p.entity_id}: entered waiting step "${p.step_name}"`)
        }
      } else if (p.step_category !== 'waiting' && !concludes && status.paused_at) {
        await this.handleSLAResume({ ...event, payload: { entity_id: p.entity_id }, timestamp: p.entered_at })
      }
    }
    // SL-3: rientro da un passo concluso a uno aperto → lo SLA si riapre, con la
    // scadenza spostata del tempo passato da risolto, e i controlli ripartono
    // (la violazione, se c'è già stata, non si ripete).
    if (!concludes && status.resolved_at) {
      const at = new Date(p.entered_at)
      if (Number.isNaN(at.getTime())) throw new Error(`[sla:engine] ${event.type}: entered_at is not a valid instant (${JSON.stringify(p.entered_at)})`)
      const reopened = await reopenSLA(event.tenant_id, p.entity_id, at)
      if (reopened && !reopened.breached) {
        await scheduleWarning(reopened)
        await scheduleBreachCheck(reopened)
      }
      console.log(`[sla:engine] SLA reopened for ${p.entity_type} ${p.entity_id} entering "${p.step_name}": resolve by ${reopened?.resolve_deadline ?? '?'}`)
      return
    }
    if (concludes && !status.resolved_at) {
      const at = new Date(p.entered_at)
      if (Number.isNaN(at.getTime())) throw new Error(`[sla:engine] ${event.type}: entered_at is not a valid instant (${JSON.stringify(p.entered_at)})`)
      const updated = await markResolveMet(event.tenant_id, p.entity_id, at)
      await cancelSLAJobs(p.entity_id)
      console.log(
        `[sla:engine] SLA closed for ${p.entity_type} ${p.entity_id} entering "${p.step_name}": ` +
          (updated?.resolve_met ? 'resolved within target' : 'resolved AFTER target (breached)'),
      )
    }
  }

  private async handleEntityResolved(
    event: DomainEvent<{ id?: string; entity_id?: string }>,
    entityType: string,
  ): Promise<void> {
    // Created events carry `id`; resolved events published by the services
    // carry `entity_id`. Accept both documented shapes — anything else is a
    // malformed event and must fail the job loudly.
    const id = event.payload.id ?? event.payload.entity_id
    if (!id) {
      throw new Error(`[sla:engine] ${event.type} payload has neither id nor entity_id`)
    }
    const existing = await getSLAStatus(event.tenant_id, id)

    if (existing?.resolved_at) {
      // Già concluso (ad esempio da workflow.step_entered): la prima
      // conclusione vince, un secondo evento non sposta data ed esito.
      console.log(`[sla:engine] SLA of ${entityType} ${id} already closed at ${existing.resolved_at} — ${event.type} ignored`)
    } else if (existing) {
      const updated = await markResolveMet(event.tenant_id, id, this.resolvedInstant(event))
      await cancelSLAJobs(id)
      console.log(
        `[sla:engine] SLA closed for ${entityType} ${id}: ` +
          (updated?.resolve_met ? 'resolved within target' : 'resolved AFTER target (breached)'),
      )
    } else {
      console.log(`[sla:engine] No SLAStatus found for ${entityType} ${id} — skipping`)
    }
  }
}

export async function createSLAEngine(): Promise<SLAEngine> {
  initScheduler()
  const engine = new SLAEngine()
  await engine.start()
  return engine
}
