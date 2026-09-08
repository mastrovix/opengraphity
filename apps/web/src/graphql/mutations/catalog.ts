import { gql } from '@apollo/client'

// ── Service catalog (admin) ──────────────────────────────────────────────────

export const CREATE_SERVICE_CATALOG_ITEM = gql`
  mutation CreateServiceCatalogItem($input: CreateServiceCatalogItemInput!) {
    createServiceCatalogItem(input: $input) {
      id name description category requiresApproval active createdAt
    }
  }
`

export const UPDATE_SERVICE_CATALOG_ITEM = gql`
  mutation UpdateServiceCatalogItem($id: ID!, $input: UpdateServiceCatalogItemInput!) {
    updateServiceCatalogItem(id: $id, input: $input) {
      id name description category requiresApproval active createdAt
    }
  }
`
