import { gql } from '@apollo/client'

// ── Watchers ─────────────────────────────────────────────────────────────────

export const WATCH_ENTITY = gql`
  mutation WatchEntity($entityType: String!, $entityId: ID!) { watchEntity(entityType: $entityType, entityId: $entityId) }
`

export const UNWATCH_ENTITY = gql`
  mutation UnwatchEntity($entityType: String!, $entityId: ID!) { unwatchEntity(entityType: $entityType, entityId: $entityId) }
`

export const ADD_WATCHER = gql`
  mutation AddWatcher($entityType: String!, $entityId: ID!, $userId: ID!) { addWatcher(entityType: $entityType, entityId: $entityId, userId: $userId) }
`

export const REMOVE_WATCHER = gql`
  mutation RemoveWatcher($entityType: String!, $entityId: ID!, $userId: ID!) { removeWatcher(entityType: $entityType, entityId: $entityId, userId: $userId) }
`

// ── Internal chat ────────────────────────────────────────────────────────────

/**
 * The same fields as `GET_INTERNAL_MESSAGES`: the sent message goes straight
 * into the list in the cache (D13), and a message missing a field there would
 * not be written.
 */
export const SEND_INTERNAL_MESSAGE = gql`
  mutation SendInternalMessage($entityType: String!, $entityId: ID!, $body: String!) {
    sendInternalMessage(entityType: $entityType, entityId: $entityId, body: $body) {
      id authorId authorName body mentions createdAt editedAt
    }
  }
`

export const EDIT_INTERNAL_MESSAGE = gql`
  mutation EditInternalMessage($messageId: ID!, $body: String!) {
    editInternalMessage(messageId: $messageId, body: $body) { id body editedAt }
  }
`

export const DELETE_INTERNAL_MESSAGE = gql`
  mutation DeleteInternalMessage($messageId: ID!) { deleteInternalMessage(messageId: $messageId) }
`

// ── Commenti di un ticket (modello unico, revisione del 14 set 2026 · F1/F13) ─

export const ADD_ENTITY_COMMENT = gql`
  mutation AddEntityComment($entityType: String!, $entityId: String!, $body: String!, $isInternal: Boolean) {
    addComment(entityType: $entityType, entityId: $entityId, body: $body, isInternal: $isInternal) {
      id body isInternal authorId authorName authorEmail createdAt updatedAt
    }
  }
`

export const COMPLETE_TICKET_TASK = gql`
  mutation CompleteTicketTask($taskId: ID!, $note: String) {
    completeTicketTask(taskId: $taskId, note: $note) {
      id state completedAt completedById
    }
  }
`

export const CANCEL_TICKET_TASK = gql`
  mutation CancelTicketTask($taskId: ID!, $reason: String!) {
    cancelTicketTask(taskId: $taskId, reason: $reason) {
      id state completedAt cancelReason
    }
  }
`

export const CLAIM_TICKET_TASK = gql`
  mutation ClaimTicketTask($taskId: ID!) {
    claimTicketTask(taskId: $taskId) {
      id assigneeId assigneeName
    }
  }
`
