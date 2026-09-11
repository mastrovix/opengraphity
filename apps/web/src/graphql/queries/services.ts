import { gql } from '@apollo/client'
import { SERVICE_MAP_ROW_FIELDS, SERVICE_MAP_DETAIL_FIELDS, SERVICE_HISTORY_FIELDS } from '../fragments'

// ── Servizi monitorati (mappa del servizio + albero d'impatto) ──────────────
// Contratto: apps/api/src/graphql/schema-services.ts. I fragment stanno in
// fragments.ts (le mutation li interpolano); qui sono re-esportati per chi
// importa «tutto dei servizi» da queries/.

export { SERVICE_MAP_ROW_FIELDS, SERVICE_MAP_DETAIL_FIELDS, SERVICE_HISTORY_FIELDS }

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

/**
 * Dettaglio completo: nodi, archi, regole e le ultime 10 voci di cronologia
 * (con il totale). Null se non esiste nel tenant. NON va in polling
 * (revisione 2 · C-8): si legge `cache-first` e si rilegge solo quando lo
 * stato dice che è cambiato qualcosa (`version`/`evaluatedAt`).
 */
export const GET_SERVICE_MAP = gql`
  query GetServiceMap($id: ID!) {
    serviceMap(id: $id) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

/**
 * La sonda del polling (C-8): tre marcatori e basta — la versione della
 * configurazione, l'istante dell'ultima valutazione e quello dell'ultima
 * sincronizzazione. Va letta `no-cache`: se scrivesse nella cache normalizzata
 * finirebbe negli stessi campi del documento completo e non ci sarebbe più
 * modo di accorgersi che il documento completo è vecchio. Quando uno dei tre è
 * più avanti di quel che la pagina ha in mano, il dettaglio si rilegge tutto.
 */
export const GET_SERVICE_MAP_STATUS = gql`
  query GetServiceMapStatus($id: ID!) {
    serviceMap(id: $id) {
      id
      version
      evaluatedAt
      syncedAt
    }
  }
`

/** Cronologia per intero, a richiesta («Mostra tutte»): il dettaglio ne carica 10. */
export const GET_SERVICE_MAP_HISTORY = gql`
  query GetServiceMapHistory($id: ID!, $limit: Int!) {
    serviceMap(id: $id) {
      id
      historyCount
      history(limit: $limit) { ...ServiceHistoryFields }
    }
  }
  ${SERVICE_HISTORY_FIELDS}
`

/** Servizi la cui mappa include il CI (sezione del dettaglio CI). */
export const GET_SERVICES_IMPACTED_BY_CI = gql`
  query GetServicesImpactedByCI($ciId: ID!) {
    servicesImpactedByCI(ciId: $ciId) { ...ServiceMapRowFields }
  }
  ${SERVICE_MAP_ROW_FIELDS}
`

/**
 * Diff fra la mappa attuale e quella che si costruirebbe adesso dal grafo
 * (dialogo «Aggiorna mappa», solo admin): nessuna scrittura, si applica con
 * `applyServiceMapProposal`. `removed` è un `ServiceMapNode`: qui bastano
 * nome, livello e ruolo per dire cosa sparirebbe.
 */
export const GET_SERVICE_MAP_PROPOSAL = gql`
  query GetServiceMapProposal($id: ID!) {
    serviceMapProposal(id: $id) {
      mapId version maxDepth relationshipTypes totalProposed
      added    { ci { id name type } level role propagate weight critical via }
      removed  { ci { id name type } level role }
      moved    { ci { id name type } level proposedLevel via proposedVia }
      excluded { id name type }
    }
  }
`

/**
 * Anteprima dal vivo: come risulterebbe il servizio adesso con le regole e/o i
 * componenti in corso di modifica. Calcolo puro sugli allarmi attuali, nessuna
 * scrittura: la pagina la richiama con debounce mentre l'admin digita.
 */
export const GET_SERVICE_IMPACT_PREVIEW = gql`
  query GetServiceImpactPreview($id: ID!, $rules: ServiceImpactRulesInput, $nodes: [ServiceMapNodeInput!]) {
    serviceImpactPreview(id: $id, rules: $rules, nodes: $nodes) {
      health impactScore contributingCount nodeCount
      causes { ci { id name type } health weight critical path { id name } }
    }
  }
`

/**
 * Solo i contatori del tenant (widget «Salute dei servizi»): nessun elemento
 * selezionato, `limit: 1` perché `counts` è comunque un aggregato su tutto il
 * tenant, indipendente da filtro e paginazione.
 */
export const GET_SERVICE_HEALTH_COUNTS = gql`
  query GetServiceHealthCounts {
    serviceMaps(limit: 1) {
      counts { total operational degraded down maintenance unknown }
    }
  }
`

/**
 * Capacità di business con la salute peggiore fra i servizi collegati (ondata
 * 3, sola lettura): una query sola, nessun controllo di modifica in pagina.
 */
export const GET_BUSINESS_CAPABILITIES_HEALTH = gql`
  query GetBusinessCapabilitiesHealth {
    businessCapabilitiesHealth {
      id name health downServices degradedServices
      services { id name criticality ownerGroup { id name } }
    }
  }
`

/** BusinessApplication ancora senza mappa (dialogo «Crea una mappa», solo admin). */
export const GET_SERVICE_MAP_CANDIDATES = gql`
  query GetServiceMapCandidates($search: String, $limit: Int) {
    serviceMapCandidates(search: $search, limit: $limit) {
      id name criticality ownerGroup { id name }
    }
  }
`
