import { gql } from '@apollo/client'

/** I ruoli dell'organizzazione (ondata 7): nome, permessi, quante persone li hanno. */
export const GET_ROLES = gql`
  query GetRoles {
    roles { key name permissions isFactory userCount }
  }
`
