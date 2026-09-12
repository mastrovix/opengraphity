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

/**
 * Sostituisce le soglie delle fasce di rischio. Ogni fascia deve essere nel
 * vocabolario `risk_band` del cliente, le soglie devono crescere e l'ultima
 * arrivare a 100: una scala con un buco lascerebbe dei punteggi senza fascia,
 * cioè un errore nel momento peggiore — l'apertura di una change.
 */
export const UPDATE_RISK_BAND_THRESHOLDS = gql`
  mutation UpdateRiskBandThresholds($entries: [RiskBandThresholdInput!]!) {
    updateRiskBandThresholds(entries: $entries) {
      thresholds { band upTo }
      vocabulary
      isDefault
    }
  }
`

/**
 * Crea quello che manca a questo cliente (dashboard, regole di notifica,
 * matrici, workflow). Idempotente e non distruttiva: una definizione che esiste
 * già viene saltata, non riallineata al seme.
 */
export const PROVISION_TENANT_DATA = gql`
  mutation ProvisionTenantData {
    provisionTenantData {
      dashboardCreated notificationRulesCreated matricesCreated workflows remainingGaps
    }
  }
`
