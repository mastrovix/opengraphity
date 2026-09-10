import { gql } from '@apollo/client'
import { SERVICE_MAP_DETAIL_FIELDS } from '../fragments'

// ── Servizi monitorati (solo admin) ─────────────────────────────────────────
// Le mutation che restituiscono la mappa selezionano la forma completa
// (SERVICE_MAP_DETAIL_FIELDS in fragments.ts): la cache aggiorna il dettaglio
// senza refetch e la lista (normalizzata per id) vede la nuova salute.

/** Costruzione automatica dal grafo (REALIZES → relazioni scelte, fino a maxDepth); `status` = `draft` per una bozza (default `active`, con valutazione immediata). */
export const CREATE_SERVICE_MAP = gql`
  mutation CreateServiceMap($serviceId: ID!, $maxDepth: Int, $relationshipTypes: [String!], $status: ServiceMapStatus) {
    createServiceMap(serviceId: $serviceId, maxDepth: $maxDepth, relationshipTypes: $relationshipTypes, status: $status) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

export const REEVALUATE_SERVICE_MAP = gql`
  mutation ReevaluateServiceMap($id: ID!) {
    reevaluateServiceMap(id: $id) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

/** `expectedVersion` = la versione letta: un cambio di stato sopra la modifica di un altro admin è rifiutato dall'API. */
export const SET_SERVICE_MAP_STATUS = gql`
  mutation SetServiceMapStatus($id: ID!, $expectedVersion: Int!, $status: ServiceMapStatus!) {
    setServiceMapStatus(id: $id, expectedVersion: $expectedVersion, status: $status) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

export const DELETE_SERVICE_MAP = gql`
  mutation DeleteServiceMap($id: ID!) {
    deleteServiceMap(id: $id)
  }
`

// ── Ondata 2: configurazione da interfaccia ────────────────────────────────
// Ogni scrittura porta `expectedVersion` (la versione letta): se un altro
// amministratore ha salvato nel frattempo l'API rifiuta e la pagina invita a
// ricaricare, mai una sovrascrittura silenziosa.

/** Soglie e opzioni delle regole d'impatto, tutte insieme (riquadro «Come si calcola»). */
export const UPDATE_SERVICE_IMPACT_RULES = gql`
  mutation UpdateServiceImpactRules($id: ID!, $expectedVersion: Int!, $rules: ServiceImpactRulesInput!) {
    updateServiceImpactRules(id: $id, expectedVersion: $expectedVersion, rules: $rules) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

/** Solo «pesa», peso e critico dei componenti passati: la tabella manda i soli nodi cambiati. */
export const UPDATE_SERVICE_MAP_NODES = gql`
  mutation UpdateServiceMapNodes($id: ID!, $expectedVersion: Int!, $nodes: [ServiceMapNodeInput!]!) {
    updateServiceMapNodes(id: $id, expectedVersion: $expectedVersion, nodes: $nodes) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

/** Applica il diff scelto nel dialogo «Aggiorna mappa»: aggiunti, esclusi per sempre, tolti. */
export const APPLY_SERVICE_MAP_PROPOSAL = gql`
  mutation ApplyServiceMapProposal($id: ID!, $expectedVersion: Int!, $add: [ID!]!, $exclude: [ID!]!, $remove: [ID!]!) {
    applyServiceMapProposal(id: $id, expectedVersion: $expectedVersion, add: $add, exclude: $exclude, remove: $remove) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`

/** Riammette un CI escluso: tornerà nella prossima proposta. */
export const REMOVE_SERVICE_MAP_EXCLUSION = gql`
  mutation RemoveServiceMapExclusion($id: ID!, $expectedVersion: Int!, $ciId: ID!) {
    removeServiceMapExclusion(id: $id, expectedVersion: $expectedVersion, ciId: $ciId) { ...ServiceMapDetailFields }
  }
  ${SERVICE_MAP_DETAIL_FIELDS}
`
