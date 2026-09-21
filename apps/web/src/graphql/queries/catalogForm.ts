import { gql } from '@apollo/client'

// ── Moduli del catalogo servizi (ondata 1) ──────────────────────────────────
// Contratto: apps/api/src/graphql/schema-catalogForm.ts. La definizione viaggia
// come stringa JSON — è dato del cliente e cambia forma con le ondate, mentre
// lo schema GraphQL è per tenant e si ricostruisce a ogni modifica del
// metamodello: tipizzarla vorrebbe dire ricostruirlo a ogni modifica di un
// modulo.

/** Il modulo pronto da compilare, con i campi che cita già risolti (etichette e scelte). */
export const GET_CATALOG_FORM_TO_FILL = gql`
  query GetCatalogFormToFill($itemId: ID!, $endUser: Boolean, $language: String) {
    catalogFormToFill(itemId: $itemId, endUser: $endUser) {
      itemId
      revision
      definition
      fields {
        name fieldType label required vocabulary help formula refTypes refFilter shared
        labels { language label }
        helps { language label }
        options(language: $language) { value label }
        tableColumns(language: $language) { name label fieldType required options { value label } }
      }
    }
  }
`

/**
 * La libreria dei campi del tenant (pagina della libreria e costruttore).
 *
 * `tableDefinition` NON si può togliere da qui: la scheda di modifica lo legge
 * per riempire l'editor delle colonne. Quando mancava, aprire una tabella solo
 * per correggerne l'etichetta apriva l'editor VUOTO, e salvando si mandava
 * «nessuna colonna» — l'API rifiutava con «la tabella non ha colonne»,
 * accusando una tabella che le aveva. Un campo tabella era di fatto non
 * modificabile (revisione del 17 set 2026).
 */
export const GET_FORM_FIELDS = gql`
  query GetFormFields($language: String) {
    formFields {
      id name fieldType label required vocabulary help validationScript formula inList refTypes refFilter shared usedBy createdAt updatedAt
      tableDefinition
      labels { language label }
      helps { language label }
      options(language: $language) { value label }
    }
  }
`

/** Il modulo di una voce, per il costruttore. */
export const GET_CATALOG_FORM = gql`
  query GetCatalogForm($itemId: ID!) {
    catalogForm(itemId: $itemId) {
      itemId itemName revision definition updatedAt
    }
  }
`

/** Le voci del catalogo con il loro iter (moduli del catalogo, ondata 3). */
export const GET_CATALOG_ITEMS_WITH_WORKFLOW = gql`
  query GetCatalogItemsWithWorkflow {
    serviceCatalogItems {
      id name category active requiresApproval
      workflowDefinitionId workflowDefinitionName
    }
  }
`

/** Il tetto tecnico sui moduli e quanto ne è occupato (ondata 4). */
export const GET_CATALOG_FORM_LIMITS = gql`
  query GetCatalogFormLimits {
    catalogFormLimits { maxLibraryFields maxFieldsPerForm maxTableRows libraryFieldsUsed min max }
  }
`
