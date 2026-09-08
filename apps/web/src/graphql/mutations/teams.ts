import { gql } from '@apollo/client'

// ── Teams ────────────────────────────────────────────────────────────────────

export const CREATE_TEAM = gql`
  mutation CreateTeam($input: CreateTeamInput!) {
    createTeam(input: $input) { id name description }
  }
`

export const SET_TEAM_MANAGER = gql`
  mutation SetTeamManager($teamId: ID!, $userId: ID!) {
    setTeamManager(teamId: $teamId, userId: $userId) { id }
  }
`

export const REMOVE_TEAM_MANAGER = gql`
  mutation RemoveTeamManager($teamId: ID!) {
    removeTeamManager(teamId: $teamId) { id }
  }
`

export const SET_CHANGE_MANAGER_TEAM = gql`
  mutation SetChangeManagerTeam($teamId: ID!, $value: Boolean!) {
    setChangeManagerTeam(teamId: $teamId, value: $value) { id isChangeManager }
  }
`
