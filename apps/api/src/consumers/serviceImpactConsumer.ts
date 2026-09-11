/**
 * Servizi monitorati — innesco della valutazione dagli eventi di dominio.
 *
 * Consumer di dominio (pattern EscalationConsumer) su due eventi:
 *
 *  - `ci.health_changed` (pubblicato da services/events/ciHealth.ts e da
 *    setCIHealthOverride, payload `{ci_id, previous_health, new_health}`):
 *    trova le mappe del tenant che includono il CI (status ≠ paused) e accoda
 *    UN job per mappa sulla coda `services-impact`
 *    (jobs/serviceImpactWorker.ts) con job id fisso `svc-<tenant>-<mapId>` e
 *    ritardo di 2 s — BullMQ scarta i doppioni, quindi una raffica di CI dello
 *    stesso servizio produce una sola valutazione.
 *  - `event.storm_ended` (revisione 2 · D6.4): mentre la sorgente era in
 *    tempesta le mappe con `during_storm = 'hold'` NON hanno cambiato salute
 *    (valutazione sospesa, nota sulla mappa). Finita la tempesta vanno
 *    rivalutate subito, senza aspettare la passata periodica: si cercano le
 *    mappe che includono un CI con allarmi di quella sorgente e si accoda una
 *    valutazione per ciascuna (trigger `maintenance`, la famiglia dei
 *    «la sospensione è cambiata»).
 *
 * La coda di questo consumer (`service-impact-consumer`) è nella lista di
 * fan-out di packages/events/src/publisher.ts. Un payload senza `ci_id` (o
 * senza `source_id`) è una violazione del contratto: errore (il job fallisce
 * visibilmente), non un ritorno silenzioso.
 */
import { BaseConsumer } from '@opengraphity/events'
import { getSession, runQuery } from '@opengraphity/neo4j'
import type { CIHealthChangedPayload, DomainEvent } from '@opengraphity/types'
import { logger } from '../lib/logger.js'
import { findMapsIncludingCI } from '../services/serviceImpact/engine.js'
import { enqueueServiceMapEvaluation } from '../jobs/serviceImpactWorker.js'

export const SERVICE_IMPACT_CONSUMER_QUEUE = 'service-impact-consumer'
export const CI_HEALTH_CHANGED_EVENT = 'ci.health_changed'
export const EVENT_STORM_ENDED_EVENT = 'event.storm_ended'

const log = logger.child({ module: 'service-impact' })

/**
 * Le mappe (non in pausa) che includono almeno un CI con un allarme di questa
 * sorgente: quelle che la tempesta può aver sospeso. Si guardano TUTTI gli
 * allarmi della sorgente, non i soli accesi — un allarme rientrato durante la
 * tempesta è proprio quello che la mappa non ha potuto vedere.
 */
export const MAPS_TOUCHED_BY_SOURCE_CYPHER = `
  MATCH (e:Event {tenant_id: $tenantId, source_id: $sourceId})-[:RAISED_ON]->(ci {tenant_id: $tenantId})
  MATCH (m:ServiceMap {tenant_id: $tenantId})-[:INCLUDES]->(ci)
  WHERE m.status <> 'paused'
  RETURN DISTINCT m.id AS id
  ORDER BY id`

/** Payload di `event.storm_ended` per la parte che interessa qui (services/events/storm.ts). */
interface StormEndedPayload { source_id?: string; source_name?: string }

export class ServiceImpactConsumer extends BaseConsumer<CIHealthChangedPayload> {
  constructor() {
    super(SERVICE_IMPACT_CONSUMER_QUEUE)
  }

  async process(event: DomainEvent<CIHealthChangedPayload>): Promise<void> {
    if (event.type === EVENT_STORM_ENDED_EVENT) return this.stormEnded(event as unknown as DomainEvent<StormEndedPayload>)
    if (event.type !== CI_HEALTH_CHANGED_EVENT) return
    const payload = (event.payload ?? {}) as Partial<CIHealthChangedPayload>
    const ciId = payload.ci_id ?? payload.id
    if (!ciId) throw new Error(`[service-impact] ${CI_HEALTH_CHANGED_EVENT} ${event.id} has no ci_id (tenant ${event.tenant_id})`)
    const tenantId = event.tenant_id

    const maps = await findMapsIncludingCI(tenantId, ciId)
    if (maps.length === 0) return
    for (const m of maps) await enqueueServiceMapEvaluation(tenantId, m.id, 'ci_health')
    log.info({ tenantId, ciId, previousHealth: payload.previous_health ?? null, newHealth: payload.new_health ?? null, maps: maps.map((m) => m.id) }, 'CI health changed: service map evaluations enqueued')
  }

  /** Fine della tempesta: le mappe coinvolte tornano valutabili e si rivalutano subito (D6.4). */
  private async stormEnded(event: DomainEvent<StormEndedPayload>): Promise<void> {
    const tenantId = event.tenant_id
    const sourceId = (event.payload ?? {}).source_id
    if (!sourceId) throw new Error(`[service-impact] ${EVENT_STORM_ENDED_EVENT} ${event.id} has no source_id (tenant ${tenantId})`)
    const session = getSession()
    let maps: { id: string }[]
    try {
      maps = await runQuery<{ id: string }>(session, MAPS_TOUCHED_BY_SOURCE_CYPHER, { tenantId, sourceId })
    } finally { await session.close() }
    if (maps.length === 0) return
    for (const m of maps) await enqueueServiceMapEvaluation(tenantId, m.id, 'maintenance')
    log.info({ tenantId, sourceId, maps: maps.map((m) => m.id) }, 'Alert storm ended: service map evaluations enqueued (suspended evaluations resume)')
  }
}
