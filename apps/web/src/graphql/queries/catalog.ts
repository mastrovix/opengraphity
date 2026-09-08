import { gql } from '@apollo/client'

// ── Service catalog (admin) ──────────────────────────────────────────────────

export const GET_SERVICE_CATALOG_ADMIN = gql`
  query GetServiceCatalogAdmin {
    serviceCatalogItems {
      id name description category requiresApproval active createdAt
    }
  }
`
