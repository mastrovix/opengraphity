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
