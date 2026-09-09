import { gql } from '@apollo/client'
import { EVENT_FIELDS } from '../fragments'

// ── Event Management (console allarmi) ──────────────────────────────────────
// Contratto: apps/api/src/graphql/schema-events.ts (eventsSDL). La selezione
// dell'evento è unica (EVENT_FIELDS in fragments.ts) così lista, dettaglio,
// mutation e le liste di incident/change leggono la stessa forma e la cache
// Apollo normalizza per id.

export const GET_EVENTS = gql`
  query GetEvents($filter: EventFilter, $limit: Int, $offset: Int) {
    events(filter: $filter, limit: $limit, offset: $offset) {
      total
      items { ...EventFields }
    }
  }
  ${EVENT_FIELDS}
`

export const GET_EVENT = gql`
  query GetEvent($id: ID!) {
    event(id: $id) { ...EventFields }
  }
  ${EVENT_FIELDS}
`

export const GET_EVENT_STATS = gql`
  query GetEventStats {
    eventStats { firing critical warning orphan suppressed flapping resolved24h }
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
      openIncidentFrom groupBy openDelaySeconds autoResolve
      suppressUpstreamHops flapThreshold flapWindowMinutes retentionDays severityMap
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

export const GET_MONITORING_SOURCES = gql`
  query GetMonitoringSources {
    monitoringSources { ...MonitoringSourceFields }
  }
  ${MONITORING_SOURCE_FIELDS}
`

/** Payload di esempio realistico del connettore: alimenta il mappatore ("usa esempio") e i frammenti di configurazione. */
export const GET_SAMPLE_INBOUND_PAYLOAD = gql`
  query GetSampleInboundPayload($connectorKind: String!) {
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
      down degraded operational unmonitored total
      items {
        id name type environment health healthSource healthSince lastEventAt
        firingEvents dependents ownerTeam
      }
    }
  }
`
