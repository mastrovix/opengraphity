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
    id name status health healthSince impactScore stale nodeCount evaluatedAt
    service { id name criticality ownerGroup { id name } }
    explanation { ci { id name type } health weight critical path { id name } }
  }
`

export const SERVICE_MAP_DETAIL_FIELDS = gql`
  fragment ServiceMapDetailFields on ServiceMap {
    ...ServiceMapRowFields
    version updatedAt maxDepth relationshipTypes builtFrom
    rules { version downSharePct degradedSharePct minNodes unknownNodes openIncidentFrom }
    nodes { ci { id name type } level role propagate weight critical via addedBy health inMaintenance contributes }
    edges { source target relType }
    history(limit: 50) {
      id at health previousHealth impactScore trigger note
      causes { ci { id name type } health weight critical path { id name } }
    }
    historyCount
  }
  ${SERVICE_MAP_ROW_FIELDS}
`
