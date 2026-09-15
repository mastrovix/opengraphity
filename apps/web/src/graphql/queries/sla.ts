import { gql } from '@apollo/client'

// ── SLA policies, OLA/UC contracts, SLA report ───────────────────────────────

export const GET_SLA_POLICIES = gql`
  query GetSLAPolicies($entityType: String, $filters: String, $sortField: String, $sortDirection: String) {
    slaPolicies(entityType: $entityType, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name entityType priority category teamId teamName
      timezone responseMinutes resolveMinutes businessHours calendarId calendarName
      complianceTarget complianceWarning warningMinutes enabled
    }
  }
`

export const GET_OLA_CONTRACTS = gql`
  query GetOLAContracts($type: String) {
    olaContracts(type: $type) {
      id type name description entityType responseMinutes resolveMinutes
      businessHours calendarId calendarName complianceTarget complianceWarning
      partyType partyName teamId teamName enabled createdAt
    }
  }
`

export const GET_SLA_REPORT = gql`
  query GetSLAReport($windowDays: Int) {
    slaReport(windowDays: $windowDays) {
      generatedAt
      windowDays
      sla {
        total met breached paused openOnTrack breachRate avgResolutionMinutes
        byPriority { priority total met breached }
        byPolicy { policyId policyName setByRule entityType responseMinutes resolveMinutes complianceTarget complianceWarning total met breached paused }
      }
    }
  }
`

/** Il rispetto dei contratti OLA / UC: pagina a sé (OLA / UC Report), stessa query dell'API. */
export const GET_OLA_REPORT = gql`
  query GetOLAReport($windowDays: Int) {
    slaReport(windowDays: $windowDays) {
      generatedAt
      windowDays
      ola {
        id type name entityType partyType partyName resolveMinutes
        evaluated met breached attainmentPct complianceTarget complianceWarning
      }
    }
  }
`

/** La policy SLA che coprirebbe un ticket con questi valori; null = nessuna. */
export const GET_SLA_COVERAGE = gql`
  query GetSLACoverage($entityType: String!, $priority: String!, $category: String, $teamId: ID) {
    slaCoverage(entityType: $entityType, priority: $priority, category: $category, teamId: $teamId) {
      policyId policyName
    }
  }
`

/** I calendari di servizio con nome (verifica «Cosa resta cablato», ondata 2). */
export const GET_SERVICE_CALENDARS = gql`
  query GetServiceCalendars {
    serviceCalendars { id name days start end holidays usedBySlaPolicies usedByOlaContracts usedByWorkflowSteps }
  }
`

/** Gli OLA/UC che riguardano un ticket, per il riquadro nel dettaglio. */
export const GET_TICKET_OLAS = gql`
  query GetTicketOLAs($entityType: String!, $entityId: ID!) {
    ticketOLAs(entityType: $entityType, entityId: $entityId) {
      contractId name type teamName resolveMinutes calendarName
      applies reason deadline concludedAt state
    }
  }
`
