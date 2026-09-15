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

export const SET_USER_ROLE = gql`
  mutation SetUserRole($userId: ID!, $role: String!) {
    setUserRole(userId: $userId, role: $role) { id role roleName permissions }
  }
`
