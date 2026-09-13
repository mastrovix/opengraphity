import { gql } from '@apollo/client'

// ── Teams ────────────────────────────────────────────────────────────────────

export const CREATE_TEAM = gql`
  mutation CreateTeam($input: CreateTeamInput!) {
    createTeam(input: $input) { id name description type sourcing }
  }
`

/**
 * Nome, descrizione, tipo o sourcing di un team che esiste. Un campo assente
 * non si tocca; tipo e sourcing si cambiano ma non si tolgono.
 */
export const UPDATE_TEAM = gql`
  mutation UpdateTeam($id: ID!, $input: UpdateTeamInput!) {
    updateTeam(id: $id, input: $input) { id name description type sourcing }
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
