import { gql } from '@apollo/client'

// ── Field visibility / requirement rules ─────────────────────────────────────

export const CREATE_FIELD_VISIBILITY_RULE = gql`
  mutation CreateFieldVisibilityRule($entityType: String!, $triggerField: String!, $triggerValue: String!, $targetField: String!, $action: String!) {
    createFieldVisibilityRule(entityType: $entityType, triggerField: $triggerField, triggerValue: $triggerValue, targetField: $targetField, action: $action) {
      id entityType triggerField triggerValue targetField action
    }
  }
`

export const UPDATE_FIELD_VISIBILITY_RULE = gql`
  mutation UpdateFieldVisibilityRule($id: ID!, $triggerField: String, $triggerValue: String, $targetField: String, $action: String) {
    updateFieldVisibilityRule(id: $id, triggerField: $triggerField, triggerValue: $triggerValue, targetField: $targetField, action: $action) {
      id entityType triggerField triggerValue targetField action
    }
  }
`

export const DELETE_FIELD_VISIBILITY_RULE = gql`
  mutation DeleteFieldVisibilityRule($id: ID!) {
    deleteFieldVisibilityRule(id: $id)
  }
`

export const SET_FIELD_REQUIREMENT = gql`
  mutation SetFieldRequirement($entityType: String!, $fieldName: String!, $required: Boolean!, $workflowStep: String) {
    setFieldRequirement(entityType: $entityType, fieldName: $fieldName, required: $required, workflowStep: $workflowStep) {
      id entityType fieldName required workflowStep
    }
  }
`

export const DELETE_FIELD_REQUIREMENT = gql`
  mutation DeleteFieldRequirement($id: ID!) {
    deleteFieldRequirement(id: $id)
  }
`
