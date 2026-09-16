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

/**
 * Duplica una definizione di workflow (moduli del catalogo, ondata 3): serve
 * all'iter per voce, perché prima si potevano solo MODIFICARE le definizioni
 * seminate. La copia nasce spenta: la si accende dopo averla sistemata.
 */
export const DUPLICATE_WORKFLOW_DEFINITION = gql`
  mutation DuplicateWorkflowDefinition($definitionId: ID!, $name: String!, $category: String) {
    duplicateWorkflowDefinition(definitionId: $definitionId, name: $name, category: $category) {
      id name entityType category active version
    }
  }
`

/**
 * Accende o spegne una definizione. Una copia nasce spenta di proposito
 * (un'attiva senza categoria entra nel ripiego di ogni ticket nuovo): questa
 * mutation è il modo di metterla in servizio quando è finita.
 */
export const SET_WORKFLOW_DEFINITION_ACTIVE = gql`
  mutation SetWorkflowDefinitionActive($definitionId: ID!, $active: Boolean!) {
    setWorkflowDefinitionActive(definitionId: $definitionId, active: $active) {
      id name active category version
    }
  }
`
