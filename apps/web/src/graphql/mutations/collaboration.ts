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

export const SEND_INTERNAL_MESSAGE = gql`
  mutation SendInternalMessage($entityType: String!, $entityId: ID!, $body: String!) {
    sendInternalMessage(entityType: $entityType, entityId: $entityId, body: $body) {
      id authorId authorName body createdAt
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
