import { gql } from '@apollo/client'

// ── SLA policies, OLA/UC contracts, SLA report ───────────────────────────────

export const GET_SLA_POLICIES = gql`
  query GetSLAPolicies($entityType: String, $filters: String, $sortField: String, $sortDirection: String) {
    slaPolicies(entityType: $entityType, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name entityType priority category teamId teamName
      timezone responseMinutes resolveMinutes businessHours enabled
    }
  }
`

export const GET_OLA_CONTRACTS = gql`
  query GetOLAContracts($type: String) {
    olaContracts(type: $type) {
      id type name description entityType responseMinutes resolveMinutes
      businessHours partyType partyName teamId teamName enabled createdAt
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
      }
      ola {
        id type name entityType partyType partyName resolveMinutes
        evaluated met breached attainmentPct
      }
    }
  }
`
