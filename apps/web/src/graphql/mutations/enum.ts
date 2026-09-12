import { gql } from '@apollo/client'

// ── Enum types ───────────────────────────────────────────────────────────────

export const CREATE_ENUM_TYPE = gql`
  mutation CreateEnumType($input: CreateEnumTypeInput!) {
    createEnumType(input: $input) {
      id name label values isSystem isShipped scope createdAt updatedAt
    }
  }
`

export const UPDATE_ENUM_TYPE = gql`
  mutation UpdateEnumType($id: ID!, $input: UpdateEnumTypeInput!) {
    updateEnumType(id: $id, input: $input) {
      id name label values isSystem isShipped scope createdAt updatedAt
    }
  }
`

export const DELETE_ENUM_TYPE = gql`
  mutation DeleteEnumType($id: ID!) {
    deleteEnumType(id: $id)
  }
`

/**
 * Personalizza un vocabolario SPEDITO col prodotto: ne crea la copia del
 * tenant con gli stessi valori e la restituisce. La copia vince in lettura
 * solo per chi la possiede (il nodo condiviso non si tocca).
 */
export const CUSTOMIZE_ENUM_TYPE = gql`
  mutation CustomizeEnumType($id: ID!) {
    customizeEnumType(id: $id) {
      id name label values isSystem isShipped scope createdAt updatedAt
    }
  }
`
