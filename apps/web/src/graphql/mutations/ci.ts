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
      id name label icon color active validationScript chainFamilies
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
      id name label icon color active validationScript chainFamilies
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
