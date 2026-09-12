import { gql } from '@apollo/client'

// ── Enum types ───────────────────────────────────────────────────────────────

export const CREATE_ENUM_TYPE = gql`
  mutation CreateEnumType($input: CreateEnumTypeInput!) {
    createEnumType(input: $input) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt
    }
  }
`

export const UPDATE_ENUM_TYPE = gql`
  mutation UpdateEnumType($id: ID!, $input: UpdateEnumTypeInput!) {
    updateEnumType(id: $id, input: $input) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt
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
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt
    }
  }
`

/**
 * Cambia NOME a un valore tenendolo al suo posto, e porta dietro tutto: i
 * record che lo usano, le liste e la mappa delle severità della policy degli
 * allarmi, le chiavi e le celle delle matrici di dominio, il valore di default.
 *
 * Era l'operazione che il prodotto non aveva (revisione delle otto ondate ·
 * C·N-2): il Dizionario sapeva solo aggiungere in coda e togliere, quindi
 * «rinominare» voleva dire spostare il valore in fondo — e tre regole di
 * dominio leggevano il vocabolario per posizione.
 */
export const RENAME_ENUM_VALUE = gql`
  mutation RenameEnumValue($id: ID!, $from: String!, $to: String!) {
    renameEnumValue(id: $id, from: $from, to: $to) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt
    }
  }
`

/**
 * Cambia l'ORDINE dei valori (lo stesso insieme, permutato). Per i vocabolari
 * di scala l'ordine porta significato — l'impatto più alto è l'ultimo valore —
 * e finora non era modificabile.
 */
export const REORDER_ENUM_VALUES = gql`
  mutation ReorderEnumValues($id: ID!, $values: [String!]!) {
    reorderEnumValues(id: $id, values: $values) {
      id name label values defaultValue isSystem isShipped scope createdAt updatedAt
    }
  }
`
