import { BaseConsumer } from '@opengraphity/events'
import type { DomainEvent, WorkflowStepEnteredPayload } from '@opengraphity/types'
import { WORKFLOW_STEP_ENTERED_EVENT } from '@opengraphity/types'
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
  createSLAStatus, markResponseMet, getSLAStatus, markResolveMet, pauseSLA, resumeSLA,
  getEntityCreatedAt, getEntityScope, type SLAPauseType,
} from './status.js'
import {
  initScheduler,
  scheduleWarning,
  scheduleBreachCheck,
  scheduleResponseCheck,
  scheduleOLABreaches,
  cancelSLAJobs,
} from './scheduler.js'
import { getActiveOLAContractsFor, getTenantTimezone } from './olaBreach.js'

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
      tiers: [{
        severity,
        response_minutes: tenantPolicy.response_minutes,
        resolve_minutes:  tenantPolicy.resolve_minutes,
        business_hours:   tenantPolicy.business_hours,
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

    // I controlli OLA/UC non dipendono dallo SLA: un contratto copre il tipo di
    // ticket anche quando nessuna policy SLA gli corrisponde. Prima si
    // armavano solo dopo aver creato lo SLA (e col fuso della policy SLA).
    const olaContracts = await this.scheduleOLAChecks(event.tenant_id, entityType, payload.id)

    const severity = getSeverity(payload)
    if (typeof severity !== 'string' || severity === '') {
      // Senza priorità non c'è policy da scegliere: nessuno SLA, e si dice.
      console.error(`[sla:engine] No SLA tier for ${entityType} severity="${String(severity)}" — NO SLA CREATED for ${payload.id}`)
      return
    }

    const policy = await resolvePolicy(event.tenant_id, entityType, severity, payload.id)
    if (!policy) {
      // Nessuna policy del tenant copre il ticket: nessuno SLA. Non è un
      // errore del job — è configurazione, e la diagnostica conta questi ticket.
      console.warn(`[sla:engine] No SLA policy matches ${entityType} ${payload.id} (severity="${severity}") — NO SLA CREATED`)
      return
    }

    const tier = policy.tiers.find((t) => t.severity === severity)
    if (!tier) {
      console.error(
        `[sla:engine] No SLA tier for ${entityType} severity="${severity}" (policy "${policy.name}") — NO SLA CREATED for ${payload.id}`,
      )
      return
    }

    // The SLA clock starts at the entity's created_at, not at consumer
    // processing time (a retried job must not push the deadlines forward).
    // The payload may carry created_at; otherwise read it from the node.
    const payloadCreatedAt = (payload as { created_at?: unknown }).created_at
    const startedAt = typeof payloadCreatedAt === 'string' && !Number.isNaN(new Date(payloadCreatedAt).getTime())
      ? new Date(payloadCreatedAt)
      : await getEntityCreatedAt(event.tenant_id, payload.id)

    const status = await createSLAStatus({
      tenantId:   event.tenant_id,
      entityId:   payload.id,
      entityType,
      severity,
      policy,
      startedAt,
    })

    await Promise.all([
      scheduleWarning(status),
      scheduleBreachCheck(status),
      scheduleResponseCheck(status),
    ])

    console.log(
      `[sla:engine] SLA started for ${entityType} ${payload.id}: ` +
        `response by ${status.response_deadline}, resolve by ${status.resolve_deadline}` +
        (olaContracts ? ` (+${olaContracts} OLA/UC checks)` : ''),
    )
  }

  /**
   * Arma un controllo per ogni contratto OLA/UC attivo sul tipo di ticket
   * (scatta a created_at + l'obiettivo del contratto). Il fuso è quello del
   * tenant: il contratto non ha un fuso suo e non deve prenderlo in prestito
   * dalla policy SLA. Ritorna quanti controlli ha armato.
   */
  private async scheduleOLAChecks(
    tenantId: string, entityType: string, entityId: string,
  ): Promise<number> {
    const contracts = await getActiveOLAContractsFor(tenantId, entityType)
    if (contracts.length === 0) return 0
    await scheduleOLABreaches({
      entityId, entityType, tenantId,
      timezone:  await getTenantTimezone(tenantId),
      contracts,
    })
    return contracts.length
  }

  private eventEntityId(event: DomainEvent<unknown>): string {
    const p = event.payload as { id?: string; entity_id?: string }
    const id = p.id ?? p.entity_id
    if (!id) throw new Error(`${event.type} event missing entity id`)
    return id
  }

  private async handleSLAPause(event: DomainEvent<unknown>, slaType: SLAPauseType): Promise<void> {
    const entityId = this.eventEntityId(event)
    const paused = await pauseSLA(event.tenant_id, entityId, slaType)
    if (paused) {
      // Stop only the paused clock's timers — they are re-created on resume.
      await cancelSLAJobs(entityId, slaType)
      console.log(`[sla:engine] SLA paused (${slaType}) for ${entityId}`)
    }
  }

  private async handleSLAResume(event: DomainEvent<unknown>): Promise<void> {
    const entityId = this.eventEntityId(event)
    const resumed = await resumeSLA(event.tenant_id, entityId)
    if (!resumed) return
    const pausedType = (resumed.paused_type ?? 'both') as SLAPauseType
    // Re-schedule only the clock(s) that were paused, skipping met targets.
    if ((pausedType === 'response' || pausedType === 'both') && !resumed.response_met) {
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
