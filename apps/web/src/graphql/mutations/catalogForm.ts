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

/**
 * Togliere un file. Serve ai campi allegato di un modulo per rimuovere un file
 * dalla BOZZA prima di inviare (ondata 2): il resolver permette la
 * cancellazione a chi l'ha caricato, quindi non serve altro permesso.
 * `AttachmentsSection` ne ha una copia locale, storica.
 */
export const DELETE_ATTACHMENT = gql`
  mutation DeleteFormAttachment($id: ID!) {
    deleteAttachment(id: $id)
  }
`
