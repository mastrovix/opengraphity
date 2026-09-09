import { gql } from '@apollo/client'

// ── Event Management ─────────────────────────────────────────────────────────
// Le mutation che restituiscono l'evento selezionano la stessa forma della
// lista (stesso set di campi di EVENT_FIELDS in queries/events.ts) così la
// cache aggiorna la riga senza refetch.

const EVENT_RESULT = gql`
  fragment EventResult on Event {
    id fingerprint externalId status severity title description
    resource resourceKind labels count
    firstSeenAt lastSeenAt resolvedAt acknowledgedAt
    acknowledgedBy { id name }
    source { id name connectorKind }
    ci { id name type status }
    incident { id number title status }
  }
`

export const ACKNOWLEDGE_EVENT = gql`
  mutation AcknowledgeEvent($id: ID!) {
    acknowledgeEvent(id: $id) { ...EventResult }
  }
  ${EVENT_RESULT}
`

export const RESOLVE_EVENT = gql`
  mutation ResolveEvent($id: ID!, $note: String) {
    resolveEvent(id: $id, note: $note) { ...EventResult }
  }
  ${EVENT_RESULT}
`

export const LINK_EVENT_TO_CI = gql`
  mutation LinkEventToCI($eventId: ID!, $ciId: ID!, $createAlias: Boolean) {
    linkEventToCI(eventId: $eventId, ciId: $ciId, createAlias: $createAlias) { ...EventResult }
  }
  ${EVENT_RESULT}
`

export const CREATE_INCIDENT_FROM_EVENT = gql`
  mutation CreateIncidentFromEvent($eventId: ID!) {
    createIncidentFromEvent(eventId: $eventId) { id number title status }
  }
`

export const CREATE_CI_ALIAS = gql`
  mutation CreateCIAlias($ciId: ID!, $kind: CIAliasKind!, $value: String!) {
    createCIAlias(ciId: $ciId, kind: $kind, value: $value) {
      id kind value source createdAt
      ci { id name type status }
    }
  }
`

export const DELETE_CI_ALIAS = gql`
  mutation DeleteCIAlias($id: ID!) {
    deleteCIAlias(id: $id)
  }
`

export const UPDATE_EVENT_POLICY = gql`
  mutation UpdateEventPolicy($input: EventPolicyInput!) {
    updateEventPolicy(input: $input) {
      openIncidentFrom groupBy openDelaySeconds autoResolve
      suppressUpstreamHops flapThreshold flapWindowMinutes retentionDays severityMap
    }
  }
`

// ── Ondata 2: sorgenti di monitoraggio e configurazione senza codice ────────

const MONITORING_SOURCE_RESULT = gql`
  fragment MonitoringSourceResult on InboundWebhook {
    id name entityType connectorKind fieldMapping defaultValues valueMapping
    enabled lastReceivedAt receiveCount lastError lastErrorAt errorCount createdAt
  }
`

/** Normalizza un payload senza ingerirlo: anteprima in tempo reale del mappatore. */
export const PREVIEW_INBOUND_EVENTS = gql`
  mutation PreviewInboundEvents($input: InboundEventPreviewInput!) {
    previewInboundEvents(input: $input) {
      externalId status severity title description resource resourceKind labels
    }
  }
`

/** Ingerisce il payload di esempio del connettore attraverso la pipeline reale: torna il numero di eventi accodati. */
export const SEND_SAMPLE_EVENT = gql`
  mutation SendSampleEvent($sourceId: ID!) {
    sendSampleEvent(sourceId: $sourceId)
  }
`

/** health = null toglie la forzatura e ricalcola dal monitoraggio. */
export const SET_CI_HEALTH_OVERRIDE = gql`
  mutation SetCIHealthOverride($ciId: ID!, $health: String) {
    setCIHealthOverride(ciId: $ciId, health: $health) { ciId health healthSource lastEventAt firingEvents }
  }
`

/** Crea la sorgente (InboundWebhook con entityType = event). Il token è visibile SOLO qui. */
export const CREATE_MONITORING_SOURCE = gql`
  mutation CreateMonitoringSource($input: CreateInboundWebhookInput!) {
    createInboundWebhook(input: $input) {
      id name token entityType connectorKind fieldMapping defaultValues valueMapping enabled createdAt
    }
  }
`

export const UPDATE_MONITORING_SOURCE = gql`
  mutation UpdateMonitoringSource($id: ID!, $input: UpdateInboundWebhookInput!) {
    updateInboundWebhook(id: $id, input: $input) { ...MonitoringSourceResult }
  }
  ${MONITORING_SOURCE_RESULT}
`

export const DELETE_MONITORING_SOURCE = gql`
  mutation DeleteMonitoringSource($id: ID!) {
    deleteInboundWebhook(id: $id)
  }
`

/** Il nuovo token è visibile SOLO nella risposta. */
export const REGENERATE_SOURCE_TOKEN = gql`
  mutation RegenerateSourceToken($id: ID!) {
    regenerateWebhookToken(id: $id) { id token }
  }
`
