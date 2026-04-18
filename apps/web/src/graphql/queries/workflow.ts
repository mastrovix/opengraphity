import { gql } from '@apollo/client'

export const GET_WORKFLOW_LIST = gql`
  query GetWorkflowList {
    workflowDefinitions {
      id name entityType category active version changeSubtype
      steps { name label type isInitial isTerminal isOpen category order }
    }
  }
`

export const GET_WORKFLOW_DEFINITION_BY_ID = gql`
  query GetWorkflowDefinitionById($id: ID!) {
    workflowDefinitionById(id: $id) {
      id name entityType category version active changeSubtype
      steps { id name label type enterActions exitActions isInitial isTerminal isOpen category order }
      transitions {
        id fromStepName toStepName trigger label requiresInput inputField condition timerHours
      }
    }
  }
`

export const GET_WORKFLOW_DEFINITION = gql`
  query GetWorkflowDefinition($entityType: String!) {
    workflowDefinition(entityType: $entityType) {
      id name entityType category version active changeSubtype
      steps { id name label type enterActions exitActions isInitial isTerminal isOpen category order }
      transitions {
        id fromStepName toStepName trigger label requiresInput inputField condition
      }
    }
  }
`
