import { gql } from '@apollo/client'

// ── Enum types ───────────────────────────────────────────────────────────────

export const GET_ENUM_TYPES = gql`
  query GetEnumTypes($scope: String, $language: String) {
    enumTypes(scope: $scope) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt valueLabelsReasonKey
      valueLabels(language: $language) { value label labels { language label } }
      valueColors { value color }
    }
  }
`

export const GET_ENUM_TYPE = gql`
  query GetEnumType($id: ID!, $language: String) {
    enumType(id: $id) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt valueLabelsReasonKey
      valueLabels(language: $language) { value label labels { language label } }
      valueColors { value color }
    }
  }
`

/**
 * I valori spediti dopo la copia, per ogni vocabolario del cliente (revisione
 * del 14 set 2026 · F20). Query a parte e solo nel Dizionario: il contesto dei
 * vocabolari, che carica GET_ENUM_TYPES su ogni pagina, non ne ha bisogno.
 */
export const GET_ENUM_SHIPPED_DRIFT = gql`
  query GetEnumShippedDrift {
    enumTypes {
      id newShippedValues
    }
  }
`

/** Cosa usa un valore: si chiede prima di rinominarlo, per dirlo nella conferma. */
export const GET_ENUM_VALUE_USAGE = gql`
  query GetEnumValueUsage($id: ID!, $value: String!) {
    enumValueUsage(id: $id, value: $value) {
      value total policyLists matrices configSites
      records { typeName fieldName count }
    }
  }
`
