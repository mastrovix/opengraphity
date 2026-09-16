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
        name fieldType label required vocabulary help
        labels { language label }
        helps { language label }
        options(language: $language) { value label }
      }
    }
  }
`

/** La libreria dei campi del tenant (pagina della libreria e costruttore). */
export const GET_FORM_FIELDS = gql`
  query GetFormFields($language: String) {
    formFields {
      id name fieldType label required vocabulary help validationScript usedBy createdAt updatedAt
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
