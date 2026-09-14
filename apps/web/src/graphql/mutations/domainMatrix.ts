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
export const UPDATE_CHANGE_ENVIRONMENT_WEIGHT = gql`
  mutation UpdateChangeEnvironmentWeight($weight: Int!) {
    updateChangeEnvironmentWeight(weight: $weight) { weight isDefault }
  }
`

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
/**
 * La lingua predefinita dell'azienda (admin). Era una costante nel codice:
 * cambiarla voleva dire ricompilare il prodotto.
 */
export const SET_TENANT_DEFAULT_LANGUAGE = gql`
  mutation SetTenantDefaultLanguage($language: String!) {
    setTenantDefaultLanguage(language: $language) { available defaultLanguage fallback }
  }
`

export const SET_TENANT_TIMEZONE = gql`
  mutation SetTenantTimezone($timezone: String!) {
    setTenantTimezone(timezone: $timezone) { timezone available }
  }
`

export const SET_TENANT_SERVICE_CALENDAR = gql`
  mutation SetTenantServiceCalendar($calendar: ServiceCalendarInput!) {
    setTenantServiceCalendar(calendar: $calendar) { days start end holidays }
  }
`

export const PROVISION_TENANT_DATA = gql`
  mutation ProvisionTenantData {
    provisionTenantData {
      dashboardCreated notificationRulesCreated matricesCreated workflows
      remainingGaps { kind params { name value } }
    }
  }
`

export const SET_PORTAL_SEVERITY_OPTIONS = gql`
  mutation SetPortalSeverityOptions($options: [PortalSeverityOptionInput!]!) {
    setPortalSeverityOptions(options: $options) { value labels { language label } }
  }
`
