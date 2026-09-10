/**
 * Servizi monitorati — innesco della valutazione dal cambio di salute di un CI.
 *
 * Consumer di dominio (pattern EscalationConsumer) su `ci.health_changed`
 * (pubblicato da services/events/ciHealth.ts e da setCIHealthOverride, payload
 * `{ci_id, previous_health, new_health}`): trova le mappe del tenant che
 * includono il CI (status ≠ paused) e accoda UN job per mappa sulla coda
 * `services-impact` (jobs/serviceImpactWorker.ts) con job id fisso
 * `svc-<tenant>-<mapId>` e ritardo di 2 s — BullMQ scarta i doppioni, quindi
 * una raffica di CI dello stesso servizio produce una sola valutazione.
 *
 * La coda di questo consumer (`service-impact-consumer`) è nella lista di
 * fan-out di packages/events/src/publisher.ts. Un payload senza `ci_id` è una
 * violazione del contratto: errore (il job fallisce visibilmente), non un
 * ritorno silenzioso.
 */
import { BaseConsumer } from '@opengraphity/events'
import type { CIHealthChangedPayload, DomainEvent } from '@opengraphity/types'
import { logger } from '../lib/logger.js'
import { findMapsIncludingCI } from '../services/serviceImpact/engine.js'
import { enqueueServiceMapEvaluation } from '../jobs/serviceImpactWorker.js'

export const SERVICE_IMPACT_CONSUMER_QUEUE = 'service-impact-consumer'
export const CI_HEALTH_CHANGED_EVENT = 'ci.health_changed'

const log = logger.child({ module: 'service-impact' })

export class ServiceImpactConsumer extends BaseConsumer<CIHealthChangedPayload> {
  constructor() {
    super(SERVICE_IMPACT_CONSUMER_QUEUE)
  }

  async process(event: DomainEvent<CIHealthChangedPayload>): Promise<void> {
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
}
