import { gql } from '@apollo/client'

// ── Anomaly detection ────────────────────────────────────────────────────────
// (RESOLVE_ANOMALY / RUN_ANOMALY_SCANNER are mutations but have always been
// exported from the queries barrel; kept here so their importers don't move.)

export const GET_ANOMALIES = gql`
  query GetAnomalies($limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    anomalies(limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id ruleKey title severity status
        entityId entityType entitySubtype entityName
        description detectedAt resolvedAt
        resolutionStatus resolutionNote resolvedBy
      }
    }
  }
`

export const GET_ANOMALY_STATS = gql`
  query GetAnomalyStats {
    anomalyStats {
      total open critical high medium low falsePositive acceptedRisk
    }
  }
`

export const RESOLVE_ANOMALY = gql`
  mutation ResolveAnomaly($id: ID!, $resolutionStatus: ResolutionStatus!, $note: String!) {
    resolveAnomaly(id: $id, resolutionStatus: $resolutionStatus, note: $note) {
      id status resolutionStatus resolutionNote resolvedBy resolvedAt
    }
  }
`

export const RUN_ANOMALY_SCANNER = gql`
  mutation RunAnomalyScanner {
    runAnomalyScanner
  }
`

export const GET_ANOMALY_SCAN_STATUS = gql`
  query GetAnomalyScanStatus {
    anomalyScanStatus {
      lastScanAt
      totalScans
    }
  }
`
