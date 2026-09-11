import { gql } from '@apollo/client'
import { EVENT_FIELDS, EVENT_HISTORY_FIELDS, EVENT_ROW_FIELDS } from '../fragments'

// ── Event Management (console allarmi) ──────────────────────────────────────
// Contratto: apps/api/src/graphql/schema-events.ts (eventsSDL). Le liste
// selezionano la riga leggera (EVENT_ROW_FIELDS in fragments.ts), dettaglio e
// mutation l'evento completo (EVENT_FIELDS): la cache Apollo normalizza per id
// e fa merge tra le due forme.

/** Lista: console (50 righe in polling), ultimi eventi del CI. */
export const GET_EVENTS = gql`
  query GetEvents($filter: EventFilter, $limit: Int, $offset: Int) {
    events(filter: $filter, limit: $limit, offset: $offset) {
      total
      items { ...EventRowFields }
    }
  }
  ${EVENT_ROW_FIELDS}
`

/** Dettaglio: evento completo + cronologia (ultime 100 voci e totale). Solo qui: le liste non la chiedono. */
export const GET_EVENT = gql`
  query GetEvent($id: ID!) {
    event(id: $id) {
      ...EventFields
      history(limit: 100) { ...EventHistoryFields }
      historyCount
    }
  }
  ${EVENT_FIELDS}
  ${EVENT_HISTORY_FIELDS}
`

/** Contatori + sorgenti in tempesta (ondata 4): banner in console e badge nelle Sorgenti. */
export const GET_EVENT_STATS = gql`
  query GetEventStats {
    eventStats {
      firing critical warning orphan suppressed flapping resolved24h
      stormSources { sourceId sourceName ratePerMinute since incidentId incidentNumber }
    }
  }
`

export const GET_CI_ALIASES = gql`
  query GetCIAliases($ciId: ID!) {
    ciAliases(ciId: $ciId) {
      id kind value source createdAt
      ci { id name type status health }
    }
  }
`

export const GET_EVENT_POLICY = gql`
  query GetEventPolicy {
    eventPolicy {
      version updatedAt
      openIncidentFrom groupBy openDelaySeconds autoResolve
      suppressUpstreamHops flapThreshold flapWindowMinutes flapStableMinutes
      stormThresholdPerMinute stormCooldownMinutes retentionDays matchShortHostname severityMap
      ignoreLifecycleStatuses
    }
  }
`

// ── Ondata 2: sorgenti di monitoraggio e configurazione senza codice ────────
// Stessa selezione per lista, modifica e risultato delle mutation
// (MONITORING_SOURCE_FIELDS in mutations/events.ts) così la cache normalizza per id.

const MONITORING_SOURCE_FIELDS = gql`
  fragment MonitoringSourceFields on InboundWebhook {
    id name entityType connectorKind fieldMapping defaultValues valueMapping
    enabled lastReceivedAt receiveCount lastError lastErrorAt errorCount createdAt
  }
`

/** Sorgenti con la configurazione completa (pagina Sorgenti, solo admin). */
export const GET_MONITORING_SOURCES = gql`
  query GetMonitoringSources {
    monitoringSources { ...MonitoringSourceFields }
  }
  ${MONITORING_SOURCE_FIELDS}
`

/** Le stesse sorgenti come riferimenti leggeri (id, nome, connettore, attiva): filtro della console e banner "nessuna sorgente", a tutto lo staff. */
export const GET_MONITORING_SOURCE_REFS = gql`
  query GetMonitoringSourceRefs {
    monitoringSourceRefs { id name connectorKind enabled }
  }
`

/**
 * Una sola sorgente per la pagina di modifica, con le impostazioni che solo
 * l'admin vede (`rateLimitPerMinute`, M7) — la lista e la console non le
 * chiedono. Revisione 2 · residuo D·5:
 * prima si leggevano TUTTE le sorgenti con la configurazione completa — script
 * di trasformazione e mappature comprese — per aprirne una.
 */
export const GET_MONITORING_SOURCE = gql`
  query GetMonitoringSource($id: ID!) {
    monitoringSource(id: $id) { ...MonitoringSourceFields rateLimitPerMinute }
  }
  ${MONITORING_SOURCE_FIELDS}
`

/** Payload di esempio realistico del connettore: alimenta il mappatore ("usa esempio") e i frammenti di configurazione. */
export const GET_SAMPLE_INBOUND_PAYLOAD = gql`
  query GetSampleInboundPayload($connectorKind: ConnectorKind!) {
    sampleInboundPayload(connectorKind: $connectorKind)
  }
`

/** Chiavi con percorso puntato di un payload incollato dall'amministratore (mappatore del connettore generic). */
export const GET_PAYLOAD_KEYS = gql`
  query GetPayloadKeys($payload: String!) {
    payloadKeys(payload: $payload) { path sample }
  }
`

export const GET_CI_HEALTH = gql`
  query GetCIHealth($ciId: ID!) {
    ciHealth(ciId: $ciId) { ciId health healthSource lastEventAt firingEvents }
  }
`

// ── Pagina "Salute CI" ───────────────────────────────────────────────────────
// Contatori del tenant + righe filtrate/paginate in un solo documento: la
// pagina fa polling (15 s) su questo e basta.

export const GET_CI_HEALTH_OVERVIEW = gql`
  query GetCIHealthOverview($filter: CIHealthFilter, $limit: Int, $offset: Int) {
    ciHealthOverview(filter: $filter, limit: $limit, offset: $offset) {
      down degraded operational unmonitored downDependents degradedDependents total
      items {
        id name type environment health healthSource healthSince lastEventAt
        firingEvents dependents servicesCount ownerTeam
      }
    }
  }
`
