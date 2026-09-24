import { gql } from '@apollo/client/core'

export const CREATE_TICKET = gql`
  mutation CreateTicket($title: String!, $description: String, $priority: String, $category: String!, $customFields: [CustomFieldInput!]) {
    createTicket(title: $title, description: $description, priority: $priority, category: $category, customFields: $customFields) {
      id type title description status priority priorityLabel priorityColor category createdAt updatedAt assignedTeam
    }
  }
`

export const ADD_TICKET_COMMENT = gql`
  mutation AddTicketComment($ticketId: ID!, $body: String!) {
    addTicketComment(ticketId: $ticketId, body: $body) {
      id body isInternal authorId authorName authorEmail createdAt
    }
  }
`

export const REOPEN_TICKET = gql`
  mutation ReopenTicket($ticketId: ID!) {
    reopenTicket(ticketId: $ticketId) {
      id status updatedAt
    }
  }
`

/** «It works»: the requester closes the resolved ticket now (tour of 23 Sep 2026, D51). */
export const CONFIRM_TICKET_RESOLUTION = gql`
  mutation ConfirmTicketResolution($ticketId: ID!) {
    confirmTicketResolution(ticketId: $ticketId) {
      id status updatedAt
    }
  }
`

export const RATE_KB_ARTICLE = gql`
  mutation RateKBArticle($id: ID!, $helpful: Boolean!) {
    rateKBArticle(id: $id, helpful: $helpful) {
      id helpfulCount notHelpfulCount myVote
    }
  }
`

export const CREATE_SERVICE_REQUEST = gql`
  mutation CreateServiceRequest($input: CreateServiceRequestInput!) {
    createServiceRequest(input: $input) { id number status }
  }
`

/** L'autore modifica o cancella la propria risposta; resta la traccia (ondata 6). */
export const UPDATE_COMMENT = gql`
  mutation UpdateComment($id: ID!, $body: String!) {
    updateComment(id: $id, body: $body) { id body editedAt editedByName }
  }
`

export const DELETE_COMMENT = gql`
  mutation DeleteComment($id: ID!) { deleteComment(id: $id) }
`

/** La lingua della persona (null = quella dell'organizzazione): la stessa del Profilo del web. */
export const SET_MY_LANGUAGE = gql`
  mutation SetMyLanguage($language: String) {
    setMyLanguage(language: $language) { id language }
  }
`

/**
 * Toglie un file caricato per sbaglio sulla bozza di un modulo. Serve davvero:
 * togliere il file solo dallo stato della pagina non lo cancella, e il reclamo
 * alla creazione guarda il GRAFO — quindi tornerebbe sul ticket (revisione del
 * 17 set 2026). `deleteAttachment` è fra i permessi di `portal.submit`, e il
 * resolver resta il guardiano: solo chi l'ha caricato.
 */
export const DELETE_FORM_ATTACHMENT = gql`
  mutation DeletePortalFormAttachment($id: ID!) {
    deleteAttachment(id: $id)
  }
`
