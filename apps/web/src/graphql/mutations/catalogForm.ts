import { gql } from '@apollo/client'

// ── Moduli del catalogo servizi (ondata 1) ──────────────────────────────────

export const CREATE_FORM_FIELD = gql`
  mutation CreateFormField($input: CreateFormFieldInput!) {
    createFormField(input: $input) { id name fieldType label required vocabulary help usedBy }
  }
`

export const UPDATE_FORM_FIELD = gql`
  mutation UpdateFormField($id: ID!, $input: UpdateFormFieldInput!) {
    updateFormField(id: $id, input: $input) { id name fieldType label required vocabulary help usedBy }
  }
`

export const DELETE_FORM_FIELD = gql`
  mutation DeleteFormField($id: ID!) { deleteFormField(id: $id) }
`

/** Salva E pubblica: la revisione sale di uno (nessuna bozza nell'ondata 1). */
export const SAVE_CATALOG_FORM = gql`
  mutation SaveCatalogForm($itemId: ID!, $definition: String!) {
    saveCatalogForm(itemId: $itemId, definition: $definition) { itemId itemName revision definition updatedAt }
  }
`
