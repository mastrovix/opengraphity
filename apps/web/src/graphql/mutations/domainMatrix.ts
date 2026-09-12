import { gql } from '@apollo/client'
import { DOMAIN_MATRIX_FIELDS } from '../fragments'

// ── Matrici di dominio (ondata 7) ────────────────────────────────────────────
// Il server rifiuta una matrice incompleta e dice quali combinazioni mancano:
// meglio l'errore qui, davanti all'admin che può rimediare, che dentro un job
// di ingest.

export const UPDATE_DOMAIN_MATRIX = gql`
  mutation UpdateDomainMatrix($kind: String!, $entries: [DomainMatrixEntryInput!]!) {
    updateDomainMatrix(kind: $kind, entries: $entries) { ...DomainMatrixFields }
  }
  ${DOMAIN_MATRIX_FIELDS}
`

export const UPDATE_PRE_APPROVED_CHANGE_TYPES = gql`
  mutation UpdatePreApprovedChangeTypes($types: [String!]!) {
    updatePreApprovedChangeTypes(types: $types) { types vocabulary }
  }
`
