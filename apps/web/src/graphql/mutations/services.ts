import { gql } from '@apollo/client'
import { SERVICE_MAP_DETAIL_FIELDS } from '../fragments'

// ── Servizi monitorati (solo admin) ─────────────────────────────────────────
// Le mutation che restituiscono la mappa selezionano la forma completa
// (SERVICE_MAP_DETAIL_FIELDS in fragments.ts): la cache aggiorna il dettaglio
// senza refetch e la lista (normalizzata per id) vede la nuova salute.

/** Costruzione automatica dal grafo (REALIZES → relazioni scelte, fino a maxDepth); status active e valutazione immediata in ondata 1. */
export const CREATE_SERVICE_MAP = gql`
  mutation CreateServiceMap($serviceId: ID!, $maxDepth: Int, $relationshipTypes: [String!]) {
    createServiceMap(serviceId: $serviceId, maxDepth: $maxDepth, relationshipTypes: $relationshipTypes) { ...ServiceMapDetailFields }
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
