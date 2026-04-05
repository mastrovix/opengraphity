import { gql } from '@apollo/client/core'

export const CREATE_TICKET = gql`
  mutation CreateTicket($title: String!, $description: String, $priority: String, $category: String!) {
    createTicket(title: $title, description: $description, priority: $priority, category: $category) {
      id type title description status priority category createdAt updatedAt assignedTeam
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

export const RATE_KB_ARTICLE = gql`
  mutation RateKBArticle($id: ID!, $helpful: Boolean!) {
    rateKBArticle(id: $id, helpful: $helpful) {
      id helpfulCount notHelpfulCount
    }
  }
`
