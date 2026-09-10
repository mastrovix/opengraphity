/**
 * Accesso al grafo per l'Event (Event Management): lettura del record,
 * esito della correlazione, aggancio all'incident. Tutte le funzioni
 * ricevono la sessione dal chiamante: la pipeline ne apre UNA per evento
 * (M11) invece di una per statement.
 */
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { NotFoundError } from '../../lib/errors.js'
import type { CorrelationOutcome } from '../../lib/eventVocabularies.js'
import { historyParams, historyWriteCypher } from './history.js'
import type { EventRecord } from './types.js'

export async function loadEventRecord(session: Session, tenantId: string, eventId: string): Promise<EventRecord> {
  const row = await runQueryOne<EventRecord>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
    RETURN properties(e) AS props, ci.id AS ciId
  `, { eventId, tenantId })
  if (!row) throw new NotFoundError('Event', eventId)
  return row
}

/** Voce di cronologia scritta da setCorrelation nello stesso statement dell'esito. */
export interface CorrelationHistory {
  /**
   * `correlated` (default): scritta solo se l'esito CAMBIA (dieta di rumore:
   * una ripetizione già agganciata non ripete la voce), con `outcome` = esito.
   * `storm` (aggancio nuovo all'incident di tempesta) e
   * `incident_opened_manually` (mutation createIncidentFromEvent): sempre scritte.
   */
  kind?:       'correlated' | 'storm' | 'incident_opened_manually'
  /** Incident dell'esito (opened/attached/reopened/storm), se c'è. */
  incidentId?: string | null
  /** Chi ha causato l'esito; default monitoring. */
  actorId?:    string
  /** Solo per `correlated`: scrivi anche se l'esito non cambia (es. CORRELATED_INTO appena creato verso un altro incident). */
  always?:     boolean
}

/**
 * Esito di correlazione + voce di cronologia in UN solo statement (history.ts):
 * se la voce non si scrive, non si scrive nemmeno l'esito.
 */
export async function setCorrelation(session: Session, tenantId: string, eventId: string, correlation: CorrelationOutcome, now: string, dueAt: string | null = null, history: CorrelationHistory = {}): Promise<void> {
  const kind = history.kind ?? 'correlated'
  const when = kind === 'correlated' && !history.always ? 'previous IS NULL OR previous <> $correlation' : 'true'
  await runQuery(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
    WITH e, e.correlation AS previous
    SET e.correlation = $correlation, e.correlation_at = $now, e.correlation_due_at = $dueAt, e.updated_at = $now
    ${historyWriteCypher({ when, imports: ['previous'] })}
  `, {
    eventId, tenantId, correlation, now, dueAt,
    ...historyParams({ kind, outcome: kind === 'correlated' ? correlation : null, incidentId: history.incidentId ?? null, actorId: history.actorId }, now),
  })
}

/** MERGE CORRELATED_INTO; true se la relazione è nuova (per non ripetere il commento a ogni ricorrenza). */
export async function attachEventToIncident(session: Session, tenantId: string, eventId: string, incidentId: string, manual: boolean, now: string): Promise<boolean> {
  const row = await runQueryOne<{ created: boolean }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
    MERGE (e)-[r:CORRELATED_INTO]->(i)
    ON CREATE SET r.created_at = $now, r.manual = $manual
    RETURN r.created_at = $now AS created
  `, { eventId, tenantId, incidentId, manual, now })
  if (!row) throw new Error(`Event ${eventId} or Incident ${incidentId} not found while correlating (tenant ${tenantId})`)
  return Boolean(row.created)
}
