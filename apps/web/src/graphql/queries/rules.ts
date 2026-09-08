import { gql } from '@apollo/client'

// ── Field visibility / requirement rules ─────────────────────────────────────

export const GET_FIELD_VISIBILITY_RULES = gql`
  query GetFieldVisibilityRules($entityType: String!) {
    fieldVisibilityRules(entityType: $entityType) {
      id entityType triggerField triggerValue targetField action
    }
  }
`

export const GET_FIELD_REQUIREMENT_RULES = gql`
  query GetFieldRequirementRules($entityType: String!, $workflowStep: String) {
    fieldRequirementRules(entityType: $entityType, workflowStep: $workflowStep) {
      id entityType fieldName required workflowStep
    }
  }
`
