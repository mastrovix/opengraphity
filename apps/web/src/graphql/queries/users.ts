import { gql } from '@apollo/client'
import { USER_REF, TEAM_REF } from '../fragments'

// ── Users ────────────────────────────────────────────────────────────────────

export const GET_USERS = gql`
  ${USER_REF}
  ${TEAM_REF}
  query GetUsers($sortField: String, $sortDirection: String) {
    users(sortField: $sortField, sortDirection: $sortDirection) {
      ...UserRef
      role roleName active createdAt
      teams { ...TeamRef }
    }
  }
`

/**
 * Chi può ricevere un ticket: il permesso «Ricevere ticket» (`ticket.assignable`)
 * del ruolo di ogni persona (ondata 7; prima «admin o operator»).
 */
export const GET_ASSIGNABLE_USERS = gql`
  query GetAssignableUsers {
    users(sortField: "name", sortDirection: "asc") {
      id name permissions active
      teams { id }
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
      roleName
      permissions
      slackId
      emailNotifications
      language
      teams { ...TeamRef }
    }
  }
`

export const GET_USER = gql`
  ${USER_REF}
  query GetUser($id: ID!) {
    user(id: $id) {
      ...UserRef
      tenantId code active firstName lastName role roleName slackId createdAt
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
  query SearchUsers($search: String!, $limit: Int, $permission: String) {
    searchUsers(search: $search, limit: $limit, permission: $permission) { id name email role }
  }
`

/**
 * The people already chosen, by id (review of 23 Sep 2026): what a rule or a
 * step names, without downloading the directory. Inactive people too — a
 * saved rule may still name one, and it should say who.
 */
export const GET_USERS_BY_IDS = gql`
  query UsersByIds($ids: [ID!]!) {
    usersByIds(ids: $ids) { id name email active }
  }
`
