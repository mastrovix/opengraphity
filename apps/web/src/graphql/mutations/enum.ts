import { gql } from '@apollo/client'

// ── Enum types ───────────────────────────────────────────────────────────────

export const CREATE_ENUM_TYPE = gql`
  mutation CreateEnumType($input: CreateEnumTypeInput!) {
    createEnumType(input: $input) {
      id name label values isSystem scope createdAt updatedAt
    }
  }
`

export const UPDATE_ENUM_TYPE = gql`
  mutation UpdateEnumType($id: ID!, $input: UpdateEnumTypeInput!) {
    updateEnumType(id: $id, input: $input) {
      id name label values isSystem scope createdAt updatedAt
    }
  }
`

export const DELETE_ENUM_TYPE = gql`
  mutation DeleteEnumType($id: ID!) {
    deleteEnumType(id: $id)
  }
`
