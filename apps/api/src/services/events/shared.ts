/**
 * Event Management — costanti e helper condivisi da tutti i moduli di
 * `services/events/` (revisione, 3.4: `MONITORING_ACTOR`, `toStr`, `toNumber`
 * e `monitoringContext` erano definiti tre volte in eventCorrelation,
 * eventStorm ed eventRetention). Questo modulo non tocca il grafo e non
 * importa nulla dell'Event Management: è la foglia del grafo dei moduli.
 */
import type { MonitoringEventPayload } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'
import { EVENT_SEVERITIES, type EventSeverity } from '../../lib/eventVocabularies.js'

export type Props = Record<string, unknown>

/** actor_id / userId delle azioni automatiche (audit, eventi di dominio, commenti, incident). */
export const MONITORING_ACTOR = 'monitoring'

/** Ordine delle severità (soglie, "mai in discesa" della transizione, priorità dell'incident). */
export const SEVERITY_RANK: Readonly<Record<EventSeverity, number>> = { info: 0, warning: 1, critical: 2 }

export function toStr(v: unknown): string { return v == null ? '' : typeof v === 'string' ? v : String(v) }

/** Conteggi Neo4j (Integer o number) → number; null → 0. Locale per non dipendere dall'export `toNumber` del driver nei mock. */
export function toNumber(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'object' && 'toNumber' in v && typeof (v as { toNumber: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber()
  return Number(v)
}

/** Contesto sintetico per audit e servizi: l'attore è il monitoraggio. */
export function monitoringContext(tenantId: string): GraphQLContext {
  return { tenantId, userId: MONITORING_ACTOR, userEmail: MONITORING_ACTOR, role: 'admin' }
}

export function assertSeverity(value: unknown, eventId: string): EventSeverity {
  if (typeof value !== 'string' || !(EVENT_SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(`Event ${eventId} has an invalid severity ${JSON.stringify(value)}`)
  }
  return value as EventSeverity
}

/** Payload comune degli eventi di dominio `event.*` a partire dalle proprietà del nodo Event. */
export function mapEventPayload(props: Props, ciId: string | null): MonitoringEventPayload {
  const id = String(props['id'])
  return {
    id,
    fingerprint: String(props['fingerprint']),
    title:       String(props['title']),
    severity:    String(props['severity']) as MonitoringEventPayload['severity'],
    status:      String(props['status'])   as MonitoringEventPayload['status'],
    resource:    String(props['resource']),
    count:       Number(props['count'] ?? 0),
    ci_id:       ciId,
    source_id:   String(props['source_id']),
    entity_type: 'event',
    entity_id:   id,
  }
}
