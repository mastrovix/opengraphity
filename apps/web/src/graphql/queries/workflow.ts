import { gql } from '@apollo/client'

export const GET_WORKFLOW_LIST = gql`
  query GetWorkflowList($includeInactive: Boolean) {
    workflowDefinitions(includeInactive: $includeInactive) {
      id name entityType category active version
      steps { name label type isInitial isTerminal isOpen category purpose order }
    }
  }
`

export const GET_WORKFLOW_DEFINITION_BY_ID = gql`
  query GetWorkflowDefinitionById($id: ID!) {
    workflowDefinitionById(id: $id) {
      id name entityType category version active
      steps { id name label labels { language label } type enterActions exitActions isInitial isTerminal isOpen category purpose deadline order currentInstances positionX positionY }
      transitions {
        id fromStepName toStepName trigger label requiresInput inputField condition timerHours sourceHandle targetHandle
      }
    }
  }
`

export const GET_WORKFLOW_DEFINITION = gql`
  query GetWorkflowDefinition($entityType: String!) {
    workflowDefinition(entityType: $entityType) {
      id name entityType category version active
      steps { id name label labels { language label } type enterActions exitActions isInitial isTerminal isOpen category purpose order }
      transitions {
        id fromStepName toStepName trigger label labels { language label } requiresInput inputField condition
      }
    }
  }
`
