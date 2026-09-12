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
