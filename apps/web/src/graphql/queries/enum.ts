import { gql } from '@apollo/client'

// ── Enum types ───────────────────────────────────────────────────────────────

export const GET_ENUM_TYPES = gql`
  query GetEnumTypes($scope: String, $language: String) {
    enumTypes(scope: $scope) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt
      valueLabels(language: $language) { value label labels { language label } }
    }
  }
`

export const GET_ENUM_TYPE = gql`
  query GetEnumType($id: ID!, $language: String) {
    enumType(id: $id) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt
      valueLabels(language: $language) { value label labels { language label } }
    }
  }
`
