/**
 * Fixture dei Servizi monitorati per i test (MockedProvider): l'esempio
 * «Enterprise Billing» del progetto — api-03 (livello 1, peso 8, critico),
 * db-01 (peso 5, giù), cache-02 (peso 3, degradato), cert-billing (peso 3,
 * non pesa, salute sconosciuta) → degradato, punteggio 41. I risultati
 * includono `__typename` perché la cache Apollo 4 lo aggiunge a ogni query.
 */
import { GET_SERVICE_MAPS } from '@/graphql/queries'
import type { GqlMock } from '@/test/utils'

export const SERVICE = { __typename: 'ServiceRef', id: 'ba-1', name: 'Enterprise Billing', criticality: 'business_critical', ownerGroup: { __typename: 'Team', id: 't1', name: 'Billing Ops' } }

export const ciRef = (id: string, name: string, type: string) => ({ __typename: 'ConfigurationItemRef', id, name, type })
export const pathRef = (id: string, name: string) => ({ __typename: 'ConfigurationItemRef', id, name })

export function node(over: Record<string, unknown> & { id: string; name: string }): Record<string, unknown> {
  const { id, name, ...rest } = over
  return {
    __typename: 'ServiceMapNode', ci: ciRef(id, name, 'server'), level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false,
    via: 'api-03', addedBy: 'auto', health: 'operational', inMaintenance: false, contributes: true, excludedReason: null, ...rest,
  }
}

export const NODES: Record<string, unknown>[] = [
  node({ id: 'api-03', name: 'api-03', ci: ciRef('api-03', 'api-03', 'application'), level: 1, role: 'entry', weight: 8, critical: true, via: null }),
  node({ id: 'db-01', name: 'db-01', ci: ciRef('db-01', 'db-01', 'database'), health: 'down' }),
  node({ id: 'cache-02', name: 'cache-02', ci: ciRef('cache-02', 'cache-02', 'microservice'), role: 'component', weight: 3, health: 'degraded' }),
  node({ id: 'cert-billing', name: 'cert-billing', ci: ciRef('cert-billing', 'cert-billing', 'certificate'), role: 'certificate', propagate: 'never', weight: 3, health: null, contributes: false, excludedReason: 'never' }),
]

export const EDGES = [
  { __typename: 'ServiceMapEdge', source: 'api-03', target: 'db-01',        relType: 'DEPENDS_ON' },
  { __typename: 'ServiceMapEdge', source: 'api-03', target: 'cache-02',     relType: 'DEPENDS_ON' },
  { __typename: 'ServiceMapEdge', source: 'api-03', target: 'cert-billing', relType: 'USES_CERTIFICATE' },
]

/** db-01: il percorso NON include il nodo stesso; cache-02: lo include (il server può fare in entrambi i modi). */
export const CAUSES = [
  { __typename: 'ImpactCause', ci: ciRef('db-01', 'db-01', 'database'), health: 'down', weight: 5, critical: false, path: [pathRef('api-03', 'api-03')] },
  { __typename: 'ImpactCause', ci: ciRef('cache-02', 'cache-02', 'microservice'), health: 'degraded', weight: 3, critical: false, path: [pathRef('cache-02', 'cache-02'), pathRef('api-03', 'api-03')] },
]

export const HISTORY = [
  { __typename: 'ServiceHealthEntry', id: 'h2', at: '2026-09-10T08:30:00Z', health: 'degraded', previousHealth: 'operational', impactScore: 41, trigger: 'ci_health', causes: CAUSES, note: null },
  { __typename: 'ServiceHealthEntry', id: 'h1', at: '2026-09-10T08:00:00Z', health: 'operational', previousHealth: null, impactScore: 0, trigger: 'created', causes: [], note: null },
]

export const RULES = { __typename: 'ServiceImpactRules', version: 1, downSharePct: 50, degradedSharePct: 1, minNodes: 1, unknownNodes: 'ignore', openIncidentFrom: 'down' }

/** Riga della lista (fragment ServiceMapRowFields). */
export function mapRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'ServiceMap', id: 'map-1', name: 'Enterprise Billing', status: 'active', health: 'degraded',
    healthIfActive: null,
    healthSince: new Date(Date.now() - 42 * 60_000).toISOString(), impactScore: 41, stale: false, staleReason: null, nodeCount: 4,
    evaluatedAt: new Date(Date.now() - 2 * 60_000).toISOString(), service: SERVICE, explanation: CAUSES, ...over,
  }
}

/** Mappa completa (fragment ServiceMapDetailFields). */
export function mapDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...mapRow(), version: 3, updatedAt: '2026-09-10T07:00:00Z', maxDepth: 4,
    relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'], builtFrom: 'auto',
    rules: RULES, nodes: NODES, edges: EDGES, excluded: [], history: HISTORY, historyCount: 2,
    openIncident: null, autoSync: true, syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), ...over,
  }
}

export const COUNTS = { __typename: 'ServiceMapCounts', total: 5, operational: 2, degraded: 1, down: 1, maintenance: 0, unknown: 1 }

/**
 * Esito di `syncServiceMap` (`ServiceMapSyncResult`, revisione 2): di default
 * una sincronizzazione che non ha cambiato nulla. `skipped: true` = rifiutata
 * dal motore (tetto dei componenti), con `reason`.
 */
export function syncResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'ServiceMapSyncResult', map: mapDetail(), added: 0, removed: 0, moved: 0, skipped: false, reason: null, ...over,
  }
}

/**
 * `serviceMaps` come lo chiede il banner dei servizi critici (console allarmi):
 * per default nessuna riga, cioè nessun servizio giù e nessun banner.
 */
export function serviceMapsMock(items: Record<string, unknown>[] = []): GqlMock {
  return {
    request: { query: GET_SERVICE_MAPS, variables: () => true },
    result: { data: { serviceMaps: { __typename: 'ServiceMapPage', total: items.length, counts: COUNTS, items } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/** Incident aperto dal monitoraggio per il servizio (`ServiceMap.openIncident`, ondata 3). */
export function openIncident(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'Incident', id: 'inc-1', number: 'INC-0042', title: 'Servizio Enterprise Billing: degradato', status: 'in_progress',
    workflowInstance: { __typename: 'WorkflowInstance', id: 'wi-1', currentStep: 'in_progress', status: 'active' },
    ...over,
  }
}

/** Una capacità di business (query `businessCapabilitiesHealth`, ondata 3). */
export function capability(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'BusinessCapabilityHealth', id: 'cap-1', name: 'Fatturazione', health: 'degraded',
    downServices: 0, degradedServices: 1, services: [SERVICE], ...over,
  }
}

// ── Ondata 2: proposta (diff col grafo) e anteprima ─────────────────────────

/** Un componente nuovo proposto dal grafo (ServiceMapProposalNode). */
export const proposalNode = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  __typename: 'ServiceMapProposalNode', ci: ciRef(id, name, 'server'), level: 2, role: 'infrastructure',
  propagate: 'weighted', weight: 5, critical: false, via: 'api-03', ...over,
})

/**
 * Diff di default: due nuovi (lb-09, queue-01), uno sparito (cache-02), uno
 * spostato (db-01 dal livello 2 al 3) e un'esclusione attiva (old-vm).
 */
export function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: 'ServiceMapProposal', mapId: 'map-1', version: 3, maxDepth: 4,
    relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'],
    added: [proposalNode('lb-09', 'lb-09'), proposalNode('queue-01', 'queue-01', { level: 3, role: 'component' })],
    removed: [{ __typename: 'ServiceMapNode', ci: ciRef('cache-02', 'cache-02', 'microservice'), level: 2, role: 'component' }],
    moved: [{ __typename: 'ServiceMapMovedNode', ci: ciRef('db-01', 'db-01', 'database'), level: 2, proposedLevel: 3, via: 'api-03', proposedVia: 'lb-09' }],
    excluded: [ciRef('old-vm', 'old-vm', 'server')],
    totalProposed: 5,
    ...over,
  }
}

/** Risultato di serviceImpactPreview. */
export function preview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { __typename: 'ServiceImpactPreview', health: 'degraded', impactScore: 41, contributingCount: 3, nodeCount: 4, causes: CAUSES, ...over }
}
