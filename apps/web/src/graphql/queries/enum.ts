import { gql } from '@apollo/client'

// ── Enum types ───────────────────────────────────────────────────────────────

export const GET_ENUM_TYPES = gql`
  query GetEnumTypes($scope: String) {
    enumTypes(scope: $scope) {
      id name label values isSystem isShipped scope createdAt updatedAt
    }
  }
`

export const GET_ENUM_TYPE = gql`
  query GetEnumType($id: ID!) {
    enumType(id: $id) {
      id name label values isSystem isShipped scope createdAt updatedAt
    }
  }
`
