import { gql } from '@apollo/client'
import { SERVICE_MAP_ROW_FIELDS, SERVICE_MAP_DETAIL_FIELDS } from '../fragments'

// ── Servizi monitorati (mappa del servizio + albero d'impatto) ──────────────
// Contratto: apps/api/src/graphql/schema-services.ts. I fragment stanno in
// fragments.ts (le mutation li interpolano); qui sono re-esportati per chi
// importa «tutto dei servizi» da queries/.

export { SERVICE_MAP_ROW_FIELDS, SERVICE_MAP_DETAIL_FIELDS }

/** Lista per gravità + contatori del tenant in un solo documento: la pagina Servizi fa polling (15 s) su questo e basta. */
export const GET_SERVICE_MAPS = gql`
  query GetServiceMaps($filter: ServiceMapFilter, $limit: Int, $offset: Int) {
    serviceMaps(filter: $filter, limit: $limit, offset: $offset) {
      total
      counts { total operational degraded down maintenance unknown }
      items { ...ServiceMapRowFields }
    }
  }
  ${SERVICE_MAP_ROW_FIELDS}
`

/** Dettaglio completo: nodi, archi, regole e le ultime 50 voci di cronologia (con il totale). Null se non esiste nel tenant. */
export const GET_SERVICE_MAP = gql`
  query GetServiceMap($id: ID!) {
    serviceMap(id: $id) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

/** Servizi la cui mappa include il CI (sezione del dettaglio CI). */
export const GET_SERVICES_IMPACTED_BY_CI = gql`
  query GetServicesImpactedByCI($ciId: ID!) {
    servicesImpactedByCI(ciId: $ciId) { ...ServiceMapRowFields }
  }
  ${SERVICE_MAP_ROW_FIELDS}
`

/** BusinessApplication ancora senza mappa (dialogo «Crea una mappa», solo admin). */
export const GET_SERVICE_MAP_CANDIDATES = gql`
  query GetServiceMapCandidates($search: String, $limit: Int) {
    serviceMapCandidates(search: $search, limit: $limit) {
      id name criticality ownerGroup { id name }
    }
  }
`
