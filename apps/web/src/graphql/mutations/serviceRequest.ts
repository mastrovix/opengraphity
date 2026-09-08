import { gql } from '@apollo/client'

// ── Service requests ─────────────────────────────────────────────────────────

export const CREATE_SERVICE_REQUEST = gql`
  mutation CreateServiceRequest($input: CreateServiceRequestInput!) {
    createServiceRequest(input: $input) {
      id
      title
      priority
      status
      createdAt
    }
  }
`
