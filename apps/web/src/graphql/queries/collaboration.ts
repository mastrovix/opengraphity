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
      id body isInternal authorId authorName authorEmail createdAt updatedAt
    }
  }
`
