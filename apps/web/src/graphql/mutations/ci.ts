import { gql } from '@apollo/client'

export const UPDATE_CI = gql`
  mutation UpdateCI($id: ID!, $input: UpdateCIFieldsInput!) {
    updateCIFields(id: $id, input: $input) {
      id name status environment
    }
  }
`

// ── CI Type Designer mutations ────────────────────────────────────────────────

export const CREATE_CI_TYPE = gql`
  mutation CreateCIType($input: CreateCITypeInput!) {
    createCIType(input: $input) {
      id name label icon color active scope tenantId validationScript chainFamilies serviceRole
      fields { id name label fieldType required enumValues order
        validationScript visibilityScript defaultScript }
      relations { id name label relationshipType targetType
        cardinality direction order }
      systemRelations { id name label relationshipType targetEntity required order }
    }
  }
`

export const UPDATE_CI_TYPE = gql`
  mutation UpdateCIType($id: ID!, $input: UpdateCITypeInput!) {
    updateCIType(id: $id, input: $input) {
      id name label icon color active scope tenantId validationScript chainFamilies serviceRole
      fields { id name label fieldType required enumValues order
        validationScript visibilityScript defaultScript }
      relations { id name label relationshipType targetType
        cardinality direction order }
      systemRelations { id name label relationshipType targetEntity required order }
    }
  }
`

export const DELETE_CI_TYPE = gql`
  mutation DeleteCIType($id: ID!) {
    deleteCIType(id: $id)
  }
`

/**
 * Modifica un campo esistente (revisione delle otto ondate · A·3.1).
 *
 * Il pulsante «Modifica» del disegnatore chiamava `addCIField`, e la porta sui
 * nomi lo rifiutava **sempre** con «Il campo esiste già sul tipo»: l'unica via
 * era cancellare e ricreare, e i valori già scritti sui nodi riapparivano col
 * campo ricreato. Il nome e il tipo non si cambiano da qui, e non è una
 * dimenticanza: sono il nome della proprietà sui nodi e la forma dei valori
 * già scritti.
 */
export const UPDATE_CI_FIELD = gql`
  mutation UpdateCIField($typeId: ID!, $fieldId: ID!, $input: CIFieldUpdateInput!) {
    updateCIField(typeId: $typeId, fieldId: $fieldId, input: $input) {
      id fields { id name label fieldType required enumValues order
        validationScript visibilityScript defaultScript }
    }
  }
`

export const ADD_CI_FIELD = gql`
  mutation AddCIField($typeId: ID!, $input: CIFieldInput!) {
    addCIField(typeId: $typeId, input: $input) {
      id fields { id name label fieldType required enumValues order
        validationScript visibilityScript defaultScript }
    }
  }
`

export const REMOVE_CI_FIELD = gql`
  mutation RemoveCIField($typeId: ID!, $fieldId: ID!) {
    removeCIField(typeId: $typeId, fieldId: $fieldId) {
      id fields { id name label fieldType required enumValues order }
    }
  }
`

export const ADD_CI_RELATION = gql`
  mutation AddCIRelation($typeId: ID!, $input: CIRelationInput!) {
    addCIRelation(typeId: $typeId, input: $input) {
      id relations { id name label relationshipType targetType
        cardinality direction order }
    }
  }
`

export const REMOVE_CI_RELATION = gql`
  mutation RemoveCIRelation($typeId: ID!, $relationId: ID!) {
    removeCIRelation(typeId: $typeId, relationId: $relationId) {
      id relations { id name label relationshipType targetType
        cardinality direction order }
    }
  }
`

export const ADD_CI_RELATIONSHIP = gql`
  mutation AddCIRelationship($sourceId: ID!, $targetId: ID!, $relationType: String!) {
    addCIRelationship(sourceId: $sourceId, targetId: $targetId, relationType: $relationType)
  }
`

export const REMOVE_CI_RELATIONSHIP = gql`
  mutation RemoveCIRelationship($sourceId: ID!, $targetId: ID!, $relationType: String!) {
    removeCIRelationship(sourceId: $sourceId, targetId: $targetId, relationType: $relationType)
  }
`

// teamId null → rimuove l'assegnazione ("— non assegnato —" nel dettaglio CI)
export const ASSIGN_CI_OWNER = gql`
  mutation AssignCIOwner($ciId: ID!, $teamId: ID) {
    assignCIOwner(ciId: $ciId, teamId: $teamId) { id }
  }
`

export const ASSIGN_CI_SUPPORT_GROUP = gql`
  mutation AssignCISupportGroup($ciId: ID!, $teamId: ID) {
    assignCISupportGroup(ciId: $ciId, teamId: $teamId) { id }
  }
`
