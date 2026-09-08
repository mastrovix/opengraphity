import { gql } from '@apollo/client/core'

/**
 * Field visibility / requirement rules consumed by `useFormFieldRules`.
 * Kept inside the package so web and portal query the same selection set.
 * (`apps/web/src/graphql/queries/admin.ts` defines the same documents for the
 * admin FieldRulesPanel — same operation names, same fields.)
 */
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
