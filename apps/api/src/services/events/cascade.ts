/**
 * Event Management — politica delle CANCELLAZIONI (revisione 2 · D4.1, D4.3).
 *
 * Cancellare una sorgente, un CI o una mappa di servizio lasciava dietro di sé
 * stato «vivo» che nessuno avrebbe più chiuso: allarmi accesi di una sorgente
 * che non riceverà mai il loro `resolved`, CI rossi per sempre, incident aperti
 * senza più un CI impattato né un servizio da cui essere risolti. Qui vive la
 * regola comune: **nessuna cancellazione lascia un ticket o una salute in uno
 * stato che nessun automatismo può più cambiare**.
 *
 *  - Sorgente (`deleteInboundWebhook`): i suoi allarmi non risolti diventano
 *    `resolved` nella STESSA transazione della cancellazione (con voce di
 *    cronologia), poi la salute dei CI toccati viene ricalcolata e ogni allarme
 *    ripassa dalla pipeline in `reevaluate` — la chiusura degli incident avviene
 *    per la via normale (chiusura automatica), non con una scorciatoia.
 *  - CI: gli Event restano orfani coerenti (il CI di un Event vive solo nella
 *    relazione), ma l'incident che aveva SOLO quel CI riceve un commento: per
 *    l'operatore diventerebbe altrimenti un ticket senza motivo.
 *  - Mappa di servizio (e BusinessApplication che la porta): l'incident di
 *    servizio ancora aperto resta aperto — è storia del ticket — ma riceve un
 *    commento PRIMA che la mappa (e con lei `IMPACTS_SERVICE`) sparisca, perché
 *    dopo nessuno potrà più chiuderlo automaticamente.
 *
 * Nessun fallback silenzioso: le riconciliazioni post-commit falliscono a voce
 * alta (la cancellazione, già persistita, resta) elencando quante ne sono
 * fallite; i commenti sugli incident, invece, non devono impedire una
 * cancellazione richiesta a mano e vengono loggati.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { logger } from '../../lib/logger.js'
import { incidents } from './deps.js'
import { monitoringContext } from './shared.js'
import { historyParams, historyWriteCypher } from './history.js'
import { recomputeCIHealth } from './ciHealth.js'
import { incidentStepInfo } from './incidentWorkflow.js'
import { runEventPipeline } from './pipeline.js'

const log = logger.child({ module: 'event-cascade' })

// ── D4.1 · cancellazione di una sorgente ─────────────────────────────────────

/** Nota scritta sull'allarme (cronologia + `resolution_note`) quando la sua sorgente viene eliminata. */
export const SOURCE_DELETED_NOTE = 'sorgente eliminata: nessun payload potrà più farlo rientrare'

export interface DeleteSourceResult {
  /** false = la sorgente non esisteva (id sbagliato o già eliminata): niente da fare. */
  deleted: boolean
  /** Allarmi non risolti della sorgente portati a `resolved` dalla cancellazione. */
  resolvedEvents: number
  /** CI la cui salute è stata ricalcolata dopo la cancellazione. */
  affectedCIs: number
}

interface DeletedSourceRow { eventIds: string[]; ciIds: string[] }

/**
 * Elimina la sorgente e, NELLA STESSA transazione, risolve i suoi allarmi
 * ancora accesi (firing / soppressi / in sfarfallio): `resolved_at`,
 * `resolved_by` = chi ha cancellato, `resolution_note`, i residui azzerati come
 * fa la risoluzione manuale, e una voce di cronologia `resolved_manually` con
 * il motivo. `correlation` resta com'è: l'allarme è rientrato, non è stato
 * "de-correlato" — l'incident si chiude per la via normale.
 *
 * Dopo il commit: `recomputeCIHealth` per ogni CI toccato (pubblica
 * `ci.health_changed`, quindi i servizi si rivalutano da soli) e la pipeline in
 * `reevaluate` su ogni allarme risolto, che è ciò che chiude gli incident —
 * esattamente come la fine di una finestra di change. Un errore in questa fase
 * non annulla la cancellazione ma propaga (fail-loud) con il conteggio.
 *
 * Limite dichiarato: la risoluzione non è paginata (una transazione per tutti
 * gli allarmi accesi della sorgente) e la riconciliazione post-commit è una
 * pipeline per allarme. Una sorgente con migliaia di allarmi ACCESI tiene la
 * mutation per un po'; è il caso raro (una sorgente viva li risolve da sola) e
 * si preferisce la coerenza: o la sorgente sparisce con i suoi allarmi chiusi,
 * o non sparisce.
 */
export async function deleteSourceAndResolveEvents(tenantId: string, sourceId: string, actorId: string): Promise<DeleteSourceResult> {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  let row: DeletedSourceRow | null
  try {
    row = await runQueryOne<DeletedSourceRow>(session, `
      MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
      OPTIONAL MATCH (e:Event {tenant_id: $tenantId, source_id: $sourceId})
        WHERE e.status <> 'resolved'
      OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
      WITH w, e, ci.id AS ciId
      FOREACH (_ IN CASE WHEN e IS NULL THEN [] ELSE [1] END |
        SET e.status = 'resolved', e.resolved_at = $now, e.resolved_by = $actorId,
            e.resolution_note = $note, e.suppressed_by_change_id = null, e.flapping_since = null, e.updated_at = $now
      )
      ${historyWriteCypher({ when: 'e IS NOT NULL', fields: { id: 'randomUUID()' } })}
      WITH w, collect(DISTINCT e.id) AS eventIds, collect(DISTINCT ciId) AS ciIds
      DETACH DELETE w
      RETURN eventIds, ciIds
    `, {
      sourceId, tenantId, now, actorId, note: SOURCE_DELETED_NOTE,
      ...historyParams({ kind: 'resolved_manually', actorId, note: SOURCE_DELETED_NOTE }, now),
    })
  } finally { await session.close() }
  if (!row) return { deleted: false, resolvedEvents: 0, affectedCIs: 0 }

  const eventIds = row.eventIds ?? []
  const ciIds = row.ciIds ?? []
  const failures: string[] = []
  // Prima la salute di TUTTI i CI toccati (gli allarmi sono già tutti risolti:
  // un solo ricalcolo per CI dà il valore giusto), poi gli incident.
  for (const ciId of ciIds) {
    try { await recomputeCIHealth(tenantId, ciId, actorId) } catch (err) {
      failures.push(`CI ${ciId}`)
      log.error({ err, tenantId, sourceId, ciId }, 'CI health recomputation after source deletion failed')
    }
  }
  for (const eventId of eventIds) {
    try { await runEventPipeline({ tenantId, eventId, actorId, now, mode: 'reevaluate' }) } catch (err) {
      failures.push(`event ${eventId}`)
      log.error({ err, tenantId, sourceId, eventId }, 'Event re-evaluation after source deletion failed')
    }
  }
  log.info({ tenantId, sourceId, resolvedEvents: eventIds.length, affectedCIs: ciIds.length, failed: failures.length, actorId },
    'Monitoring source deleted: its active alerts were resolved and their CIs re-evaluated')
  if (failures.length) {
    throw new Error(`deleteInboundWebhook: source ${sourceId} was deleted and ${eventIds.length} alerts resolved, but ${failures.length} re-evaluations failed (${failures.join(', ')}) — see logs`)
  }
  return { deleted: true, resolvedEvents: eventIds.length, affectedCIs: ciIds.length }
}

// ── D4.3 · commenti sugli incident rimasti senza la loro causa ───────────────

/** Commento scritto sull'incident quando sparisce l'ULTIMO CI impattato. */
export function ciDeletedComment(ciName: string): string {
  return `Il CI "${ciName}" è stato eliminato dalla CMDB: era l'unico CI impattato di questo incident, che resta aperto ma non potrà più essere chiuso dal monitoraggio (gli allarmi correlati non hanno più un CI).`
}

/** Commento scritto sull'incident di servizio quando la mappa che lo apriva viene eliminata. */
export function serviceMapDeletedComment(serviceName: string): string {
  return `Il servizio "${serviceName}" non è più monitorato: la mappa dei componenti è stata eliminata. L'incident resta aperto ma non verrà più chiuso automaticamente dal ripristino del servizio.`
}

/** Incident non terminali che perdono il loro ULTIMO CI impattato con la cancellazione di `ciId`. */
export async function findIncidentsLosingTheirOnlyCI(session: Session, tenantId: string, ciId: string): Promise<{ ciName: string; incidentIds: string[] }> {
  const info = await incidentStepInfo(session, tenantId)
  const rows = await runQuery<{ incidentId: string; ciName: string | null }>(session, `
    MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
    MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    WHERE NOT wi.current_step IN $terminalSteps
    OPTIONAL MATCH (i)-[:AFFECTED_BY]->(other:ConfigurationItem {tenant_id: $tenantId})
      WHERE other.id <> $ciId
    WITH i, ci.name AS ciName, count(DISTINCT other) AS others
    WHERE others = 0
    RETURN i.id AS incidentId, ciName
  `, { tenantId, ciId, terminalSteps: info.terminalSteps })
  return { ciName: rows[0]?.ciName ?? ciId, incidentIds: rows.map((r) => r.incidentId) }
}

/** Incident di servizio non terminali collegati alla mappa `mapId` (con il nome del servizio). */
export async function findIncidentsOfServiceMap(session: Session, tenantId: string, mapId: string): Promise<{ serviceName: string; incidentIds: string[] }> {
  const info = await incidentStepInfo(session, tenantId)
  const rows = await runQuery<{ incidentId: string; serviceName: string | null }>(session, `
    MATCH (i:Incident {tenant_id: $tenantId})-[:IMPACTS_SERVICE]->(m:ServiceMap {id: $mapId, tenant_id: $tenantId})
    MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    WHERE NOT wi.current_step IN $terminalSteps
    RETURN i.id AS incidentId, m.name AS serviceName
  `, { tenantId, mapId, terminalSteps: info.terminalSteps })
  return { serviceName: rows[0]?.serviceName ?? mapId, incidentIds: rows.map((r) => r.incidentId) }
}

/**
 * Commento sugli incident di servizio ancora aperti di una mappa, PRIMA che la
 * mappa (e con lei `IMPACTS_SERVICE`) sparisca: senza mappa
 * `resolveServiceIncident` non ha da dove ripartire e l'incident resterebbe
 * aperto per sempre senza che nulla lo dica. Chiamato da `deleteServiceMap` e
 * dalla cancellazione della BusinessApplication che porta la mappa.
 * Restituisce quanti commenti sono stati scritti.
 */
export async function noteServiceMapDeletion(tenantId: string, mapId: string, session?: Session): Promise<number> {
  const own = session ?? getSession()
  let found: { serviceName: string; incidentIds: string[] }
  try { found = await findIncidentsOfServiceMap(own, tenantId, mapId) } finally { if (!session) await own.close() }
  return commentOnIncidents(tenantId, found.incidentIds, serviceMapDeletedComment(found.serviceName), `service_map.deleted:${mapId}`)
}

/**
 * I commenti da scrivere PRIMA che un CI sparisca dalla CMDB:
 *  (b) gli incident non terminali il cui UNICO CI impattato è questo restano
 *      aperti (è storia del ticket) ma con una nota che spiega perché nessuno
 *      li chiuderà più — gli Event correlati diventano orfani e il loro
 *      rientro non li tocca più;
 *  (a) se il CI porta una ServiceMap (BusinessApplication), la mappa viene
 *      cancellata con lui: i suoi incident di servizio ricevono la stessa nota
 *      di `deleteServiceMap`.
 * Usa la sessione del chiamante (la stessa della cancellazione, prima della
 * scrittura). Nessuno dei due commenti può impedire la cancellazione.
 */
export async function noteIncidentsBeforeCIDeletion(tenantId: string, ciId: string, session: Session): Promise<void> {
  const orphaned = await findIncidentsLosingTheirOnlyCI(session, tenantId, ciId)
  await commentOnIncidents(tenantId, orphaned.incidentIds, ciDeletedComment(orphaned.ciName), `ci.deleted:${ciId}`)
  const map = await runQueryOne<{ id: string }>(session, `
    MATCH (n:ConfigurationItem {id: $ciId, tenant_id: $tenantId})-[:HAS_SERVICE_MAP]->(m:ServiceMap {tenant_id: $tenantId})
    RETURN m.id AS id
  `, { ciId, tenantId })
  if (map) await noteServiceMapDeletion(tenantId, map.id, session)
}

/**
 * Scrive lo stesso commento su ogni incident: PRIMA della cancellazione che lo
 * lascerebbe senza causa. Un commento che fallisce viene loggato e non ferma la
 * cancellazione (che l'utente ha chiesto esplicitamente e che è già stata
 * validata): meglio un incident senza nota che una cancellazione a metà.
 */
export async function commentOnIncidents(tenantId: string, incidentIds: readonly string[], text: string, what: string): Promise<number> {
  if (incidentIds.length === 0) return 0
  const ctx = monitoringContext(tenantId)
  const service = await incidents()
  let written = 0
  for (const incidentId of incidentIds) {
    try {
      await service.addIncidentComment(incidentId, ctx, text)
      written++
    } catch (err) {
      log.error({ err, tenantId, incidentId, what }, 'Comment on an incident left without its cause could not be written')
    }
  }
  log.info({ tenantId, incidents: incidentIds.length, written, what }, 'Open incidents annotated before the deletion')
  return written
}
