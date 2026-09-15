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
      visibleToEndUser
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

/** I tipi di CI esclusi per un tipo di ticket: sostituisce l'elenco intero (revisione del 15 set 2026 · CM-8). */
export const SET_TICKET_CI_EXCLUSIONS = gql`
  mutation SetTicketCIExclusions($ticketType: String!, $ciTypes: [String!]!) {
    setTicketCIExclusions(ticketType: $ticketType, ciTypes: $ciTypes) {
      ticketType ciTypes
    }
  }
`
