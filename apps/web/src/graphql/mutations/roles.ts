import { gql } from '@apollo/client'

export const CREATE_ROLE = gql`
  mutation CreateRole($input: RoleInput!) {
    createRole(input: $input) { key name permissions isFactory userCount }
  }
`

export const UPDATE_ROLE = gql`
  mutation UpdateRole($key: String!, $input: RoleInput!) {
    updateRole(key: $key, input: $input) { key name permissions isFactory userCount }
  }
`

export const DELETE_ROLE = gql`
  mutation DeleteRole($key: String!) {
    deleteRole(key: $key)
  }
`

/** Disattiva o riattiva una persona (revisione totale · M-6). */
export const SET_USER_ACTIVE = gql`
  mutation SetUserActive($userId: ID!, $active: Boolean!) {
    setUserActive(userId: $userId, active: $active) { id active }
  }
`

export const SET_USER_ROLE = gql`
  mutation SetUserRole($userId: ID!, $role: String!) {
    setUserRole(userId: $userId, role: $role) { id role roleName permissions }
  }
`
