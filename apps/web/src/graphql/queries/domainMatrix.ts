import { gql } from '@apollo/client'
import { DOMAIN_MATRIX_FIELDS } from '../fragments'

// ── Matrici di dominio (ondata 7) ────────────────────────────────────────────
// Le regole che traducono un valore di vocabolario in un altro (priorità =
// impatto × urgenza, criticità del servizio → impatto, …). `cells` arriva già
// completa di tutte le combinazioni che i vocabolari del cliente rendono
// possibili: `value: null` è una cella da compilare, non un dato mancante da
// nascondere.

export const GET_DOMAIN_MATRICES = gql`
  query GetDomainMatrices {
    domainMatrices { ...DomainMatrixFields }
  }
  ${DOMAIN_MATRIX_FIELDS}
`

/**
 * Le criticità che valgono «servizio critico» secondo la matrice del cliente
 * (le celle che portano all'impatto più alto). Il banner della console
 * allarmi le chiede al server invece di tenerne una copia: la copia nel web
 * era il difetto C-7 — una criticità aggiunta dall'admin non compariva mai nel
 * banner, in silenzio.
 */
export const GET_CRITICAL_SERVICE_CRITICALITIES = gql`
  query GetCriticalServiceCriticalities {
    criticalServiceCriticalities
  }
`

/**
 * I tipi di change PRE-APPROVATI (ondata 8). Non è una matrice — «essere
 * pre-approvato» è un concetto del codice, non un valore rinominabile — ma per
 * l'amministratore è la stessa cosa: una regola di dominio che decide lui, e
 * vive nella stessa pagina.
 */
export const GET_PRE_APPROVED_CHANGE_TYPES = gql`
  query GetPreApprovedChangeTypes {
    preApprovedChangeTypes { types vocabulary }
  }
`

/**
 * Le **soglie** delle fasce di rischio (rimedio 3 · revisione C·N-2): quale
 * punteggio cade in quale fascia. Erano 30 e 60 scritte nel codice, con le
 * fasce lette per POSIZIONE nel vocabolario — quindi riordinarlo invertiva le
 * fasce in silenzio, e una quarta fascia era irraggiungibile pur comparendo
 * nella matrice `change_priority`.
 */
export const GET_RISK_BAND_THRESHOLDS = gql`
  query GetRiskBandThresholds {
    riskBandThresholds {
      thresholds { band upTo }
      vocabulary
      isDefault
    }
  }
`
