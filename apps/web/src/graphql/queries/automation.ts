import { gql } from '@apollo/client'

// ── Automation: auto triggers & business rules ───────────────────────────────

export const GET_AUTO_TRIGGERS = gql`
  query GetAutoTriggers($entityType: String, $filters: String, $sortField: String, $sortDirection: String) {
    autoTriggers(entityType: $entityType, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name entityType eventType conditions timerDelayMinutes
      actions enabled executionCount lastExecutedAt
    }
  }
`

export const GET_BUSINESS_RULES = gql`
  query GetBusinessRules($entityType: String, $filters: String, $sortField: String, $sortDirection: String) {
    businessRules(entityType: $entityType, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name description entityType eventType conditionLogic
      conditions actions priority stopOnMatch enabled
    }
  }
`
