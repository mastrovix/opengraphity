import { gql } from '@apollo/client'

// ── Collaboration: watchers & internal chat ──────────────────────────────────

export const GET_WATCHERS = gql`
  query GetWatchers($entityType: String!, $entityId: ID!) {
    watchers(entityType: $entityType, entityId: $entityId) { id name email watchedAt }
  }
`

export const IS_WATCHING = gql`
  query IsWatching($entityType: String!, $entityId: ID!) {
    isWatching(entityType: $entityType, entityId: $entityId)
  }
`

export const GET_INTERNAL_MESSAGES = gql`
  query GetInternalMessages($entityType: String!, $entityId: ID!, $limit: Int) {
    internalMessages(entityType: $entityType, entityId: $entityId, limit: $limit) {
      id authorId authorName body mentions createdAt editedAt
    }
  }
`

// ── Commenti di un ticket (modello unico, revisione del 14 set 2026 · F1/F13) ─

export const GET_ENTITY_COMMENTS = gql`
  query GetEntityComments($entityType: String!, $entityId: String!) {
    comments(entityType: $entityType, entityId: $entityId) {
      id body isInternal authorId authorName authorEmail createdAt updatedAt editedAt editedByName deletedAt deletedByName
    }
  }
`

/**
 * I COMPITI DI UN TICKET (20 set 2026): quelli che un passo del workflow ha
 * fatto partire. Generici — valgono per incident, problem, change e richieste
 * — a differenza dei cinque compiti delle change, che hanno le loro query.
 */
export const GET_TICKET_TASKS = gql`
  query GetTicketTasks($entityId: ID!) {
    ticketTasks(entityId: $entityId) {
      id code title description state afterTitle entityType entityId stepName
      dueAt teamId teamName assigneeId assigneeName
      createdAt completedAt completedById cancelReason
    }
  }
`
