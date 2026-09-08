import { gql } from '@apollo/client'

// ── SLA policies ─────────────────────────────────────────────────────────────

export const CREATE_SLA_POLICY = gql`
  mutation CreateSLAPolicy($input: CreateSLAPolicyInput!) {
    createSLAPolicy(input: $input) {
      id name entityType priority category teamId teamName timezone responseMinutes resolveMinutes businessHours enabled
    }
  }
`

export const UPDATE_SLA_POLICY = gql`
  mutation UpdateSLAPolicy($id: ID!, $input: UpdateSLAPolicyInput!) {
    updateSLAPolicy(id: $id, input: $input) {
      id name entityType priority category teamId teamName timezone responseMinutes resolveMinutes businessHours enabled
    }
  }
`

export const DELETE_SLA_POLICY = gql`
  mutation DeleteSLAPolicy($id: ID!) { deleteSLAPolicy(id: $id) }
`

// ── OLA / UC contracts ───────────────────────────────────────────────────────

export const CREATE_OLA_CONTRACT = gql`
  mutation CreateOLAContract($input: CreateOLAContractInput!) {
    createOLAContract(input: $input) {
      id type name entityType responseMinutes resolveMinutes partyType partyName teamName enabled createdAt
    }
  }
`

export const UPDATE_OLA_CONTRACT = gql`
  mutation UpdateOLAContract($id: ID!, $input: UpdateOLAContractInput!) {
    updateOLAContract(id: $id, input: $input) {
      id type name entityType responseMinutes resolveMinutes partyType partyName teamName enabled createdAt
    }
  }
`
