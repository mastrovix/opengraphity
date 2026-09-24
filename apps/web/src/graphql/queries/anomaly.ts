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
        description descriptionParams { key value } detectedAt resolvedAt
        resolutionStatus resolutionNote resolvedBy resolvedByName resolvedReason
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
      id status resolutionStatus resolutionNote resolvedBy resolvedByName resolvedAt
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

// ── Configurazione delle regole (verifica «Cosa resta cablato», ondata 5) ─────

const ANOMALY_RULE_FIELDS = gql`
  fragment AnomalyRuleFields on AnomalyRuleConfig {
    ruleKey enabled severity ciTypes relations threshold incidentSeverities nonProductionSeverity
    forbidden { fromType relation toType }
    spec { ciTypes relations allRelationsWhenEmpty thresholdMin thresholdMax incidentSeverities forbidden environment }
    isDefault updatedAt openCount
    problem { key message params { key value } }
  }
`

export const GET_ANOMALY_RULES = gql`
  query GetAnomalyRules {
    anomalyRules { ...AnomalyRuleFields }
    anomalyRuleOptions {
      ciTypes { name label neo4jLabel }
      relations incidentSeverities severities
    }
  }
  ${ANOMALY_RULE_FIELDS}
`

export const UPDATE_ANOMALY_RULE = gql`
  mutation UpdateAnomalyRule($ruleKey: String!, $settings: AnomalyRuleSettingsInput!) {
    updateAnomalyRule(ruleKey: $ruleKey, settings: $settings) { ...AnomalyRuleFields }
  }
  ${ANOMALY_RULE_FIELDS}
`
