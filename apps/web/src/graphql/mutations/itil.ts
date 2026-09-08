import { gql } from '@apollo/client'

// ── ITIL type designer ───────────────────────────────────────────────────────

const ITIL_TYPE_FRAGMENT = gql`
  fragment ITILTypeFields on CITypeDefinition {
    id name label icon color active validationScript
    fields {
      id name label fieldType
      required enumValues order isSystem
      enumTypeId enumTypeName
      validationScript visibilityScript defaultScript
    }
  }
`

export const UPDATE_ITIL_TYPE = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation UpdateITILType($id: ID!, $input: UpdateITILTypeInput!) {
    updateITILType(id: $id, input: $input) {
      ...ITILTypeFields
    }
  }
`

export const CREATE_ITIL_FIELD = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation CreateITILField($typeId: ID!, $input: ITILFieldInput!) {
    createITILField(typeId: $typeId, input: $input) {
      ...ITILTypeFields
    }
  }
`

export const UPDATE_ITIL_FIELD = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation UpdateITILField($typeId: ID!, $fieldId: ID!, $input: ITILFieldInput!) {
    updateITILField(typeId: $typeId, fieldId: $fieldId, input: $input) {
      ...ITILTypeFields
    }
  }
`

export const DELETE_ITIL_FIELD = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation DeleteITILField($typeId: ID!, $fieldId: ID!) {
    deleteITILField(typeId: $typeId, fieldId: $fieldId) {
      ...ITILTypeFields
    }
  }
`

export const CREATE_ITIL_CI_RELATION_RULE = gql`
  mutation CreateITILCIRelationRule($itilType: String!, $ciType: String!, $relationType: String!, $direction: String!, $description: String) {
    createITILCIRelationRule(itilType: $itilType, ciType: $ciType, relationType: $relationType, direction: $direction, description: $description) {
      id itilType ciType relationType direction description
    }
  }
`

export const DELETE_ITIL_CI_RELATION_RULE = gql`
  mutation DeleteITILCIRelationRule($id: ID!) {
    deleteITILCIRelationRule(id: $id)
  }
`
