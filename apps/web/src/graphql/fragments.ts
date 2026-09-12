/**
 * Shared fragments (E-17). One selection set for "a user reference" and "a
 * team reference": every document that embeds a user/team picks the same
 * fields, so the Apollo cache normalises them to one entry per id.
 *
 * Interpolate with `${USER_REF}` inside gql`…`; `webDocuments.test.ts`
 * resolves the interpolation when validating the documents against the schema.
 */
import { gql } from '@apollo/client'

export const USER_REF = gql`
  fragment UserRef on User { id name email }
`

export const TEAM_REF = gql`
  fragment TeamRef on Team { id name }
`

/**
 * Evento di monitoraggio (Event Management), in due selezioni:
 * - `EVENT_ROW_FIELDS` (riga): console, allarmi di incident/change, ultimi
 *   eventi del CI. Senza `description`, `labels`, `fingerprint` e gli altri
 *   campi che la riga non mostra: la console ne carica 50 in polling.
 * - `EVENT_FIELDS` (completo): dettaglio e risultati delle mutation.
 * La cache normalizza per id: il dettaglio fa merge sulla riga già in cache e
 * una mutation che restituisce l'evento completo aggiorna anche le liste.
 * Tipi: `EventRow` / `MonitoringEvent` in types/events.ts.
 * Contratto: apps/api/src/graphql/schema-events.ts.
 */
export const EVENT_ROW_FIELDS = gql`
  fragment EventRowFields on Event {
    id status severity title resource resourceKind count lastSeenAt acknowledgedAt
    source { id name connectorKind }
    ci { id name type status health }
    incident { id number title status }
    suppressedBy { id code title }
    correlation correlationAt
    flappingSince transitions24h
    matchReason
  }
`

export const EVENT_FIELDS = gql`
  fragment EventFields on Event {
    ...EventRowFields
    fingerprint externalId resourceExternalId maxSeverity description labels
    firstSeenAt resolvedAt
    acknowledgedBy { id name }
  }
  ${EVENT_ROW_FIELDS}
`

/**
 * Voce della cronologia dell'allarme (`Event.history`): selezionata solo dal
 * dettaglio (GET_EVENT), non dalle liste né dalle mutation. Tipo:
 * `EventHistoryEntry` in types/events.ts.
 */
export const EVENT_HISTORY_FIELDS = gql`
  fragment EventHistoryFields on EventHistoryEntry {
    id at kind outcome actorId
    actor { id name }
    incident { id number title }
    change { id code title }
    ci { id name type }
    severity note
  }
`

/**
 * Servizi monitorati (mappa del servizio + albero d'impatto), in due selezioni:
 * - `SERVICE_MAP_ROW_FIELDS` (riga): lista Servizi, «servizi che dipendono da
 *   questo CI». Senza nodi, archi e cronologia: la lista fa polling.
 * - `SERVICE_MAP_DETAIL_FIELDS` (completa): dettaglio e risultati delle mutation,
 *   così «Rivaluta ora» e «Metti in pausa» aggiornano la pagina dalla cache.
 * Vivono qui (non in queries/services.ts) perché le mutation li interpolano e
 * webDocuments.test.ts risolve le interpolazioni solo dal file stesso o da
 * fragments.ts. Tipi: `ServiceMapRow` / `ServiceMapDetail` in types/services.ts.
 * Contratto: apps/api/src/graphql/schema-services.ts.
 */
export const SERVICE_MAP_ROW_FIELDS = gql`
  fragment ServiceMapRowFields on ServiceMap {
    id name status health healthIfActive healthSince impactScore stale staleReason nodeCount evaluatedAt
    service { id name criticality ownerGroup { id name } }
    explanation { ci { id name type } health weight critical path { id name } }
  }
`

/**
 * Una voce della cronologia del servizio: selezionata dal dettaglio (le ultime
 * 10) e da `GET_SERVICE_MAP_HISTORY` («Mostra tutte»). Tipo:
 * `ServiceHealthEntry` in types/services.ts.
 */
export const SERVICE_HISTORY_FIELDS = gql`
  fragment ServiceHistoryFields on ServiceHealthEntry {
    id at health previousHealth impactScore trigger note
    causes { ci { id name type } health weight critical path { id name } }
  }
`

export const SERVICE_MAP_DETAIL_FIELDS = gql`
  fragment ServiceMapDetailFields on ServiceMap {
    ...ServiceMapRowFields
    version updatedAt maxDepth relationshipTypes builtFrom autoSync syncedAt healthNote
    rules { version downSharePct degradedSharePct minNodes unknownNodes openIncidentFrom duringStorm }
    nodes { ci { id name type } level role propagate weight critical via addedBy health inMaintenance contributes excludedReason }
    edges { source target relType }
    excluded { id name type }
    history(limit: 10) { ...ServiceHistoryFields }
    historyCount
    openIncident { id number title status workflowInstance { id currentStep status } }
  }
  ${SERVICE_MAP_ROW_FIELDS}
  ${SERVICE_HISTORY_FIELDS}
`

/**
 * Il servizio visto da un incident (`Incident.impactedServices`, ondata 3):
 * la selezione più leggera possibile — nome, salute, punteggio, id per il
 * link. Non riusa `ServiceMapRowFields` perché la sezione non mostra cause,
 * owner né componenti, e il dettaglio incident non deve pagarli.
 * Tipo: `ImpactedServiceRef` in types/services.ts.
 */
export const IMPACTED_SERVICE_FIELDS = gql`
  fragment ImpactedServiceFields on ServiceMap {
    id name health impactScore
  }
`

/**
 * Matrice di dominio (ondata 7): la regola che traduce un valore di
 * vocabolario in un altro. `cells` arriva già completa di tutte le
 * combinazioni che i vocabolari del cliente rendono possibili — `value: null`
 * è una cella da compilare — più le chiavi rimaste fuori vocabolario dopo una
 * rinomina (`stale`). La query e la mutation selezionano gli stessi campi, così
 * il salvataggio aggiorna la cache della pagina.
 * Contratto: apps/api/src/graphql/schema-domainMatrix.ts.
 */
export const DOMAIN_MATRIX_FIELDS = gql`
  fragment DomainMatrixFields on DomainMatrix {
    kind inputs output inputValues outputValues missing stale invalid isDefault updatedAt
    cells { key inputs value }
  }
`
