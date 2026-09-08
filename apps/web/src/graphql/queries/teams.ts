import { gql } from '@apollo/client'
import { USER_REF } from '../fragments'

// ── Teams ────────────────────────────────────────────────────────────────────

export const GET_TEAMS = gql`
  query GetTeams($filters: String, $sortField: String, $sortDirection: String) {
    teams(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name description type createdAt }
  }
`

export const GET_TEAM_DETAIL = gql`
  ${USER_REF}
  query GetTeamDetail($id: ID!) {
    team(id: $id) {
      id
      name
      members { ...UserRef }
    }
  }
`

export const GET_TEAM = gql`
  ${USER_REF}
  query GetTeam($id: ID!) {
    team(id: $id) {
      id tenantId name description type createdAt isChangeManager
      manager { ...UserRef }
      members { ...UserRef role }
      ownedCIs { id name type environment status }
      supportedCIs { id name type environment status }
    }
  }
`
