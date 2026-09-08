import { gql } from '@apollo/client'
import { USER_REF, TEAM_REF } from '../fragments'

// ── Users ────────────────────────────────────────────────────────────────────

export const GET_USERS = gql`
  ${USER_REF}
  ${TEAM_REF}
  query GetUsers($sortField: String, $sortDirection: String) {
    users(sortField: $sortField, sortDirection: $sortDirection) {
      ...UserRef
      role createdAt
      teams { ...TeamRef }
    }
  }
`

// Single definition of the "current user" document — consume it via
// `useMe()` (src/hooks/useMe.ts) so every caller shares one cache entry.
export const GET_ME = gql`
  ${USER_REF}
  ${TEAM_REF}
  query GetMe {
    me {
      ...UserRef
      role
      slackId
      teams { ...TeamRef }
    }
  }
`

export const GET_USER = gql`
  ${USER_REF}
  query GetUser($id: ID!) {
    user(id: $id) {
      ...UserRef
      tenantId code firstName lastName role slackId createdAt
      teams { id name type }
    }
  }
`

/**
 * THE user picker document: server-side search, bounded result. Pickers
 * (watchers, mentions, assignments) must use this instead of `users { … }`,
 * which loads the whole directory into N differently-named cache entries.
 */
export const SEARCH_USERS = gql`
  query SearchUsers($search: String!, $limit: Int) {
    searchUsers(search: $search, limit: $limit) { id name email }
  }
`
