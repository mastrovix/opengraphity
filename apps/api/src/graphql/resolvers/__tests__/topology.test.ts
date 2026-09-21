/**
 * topology.ts — le etichette dei CI vengono dal metamodello del tenant
 * (ondata 6: A-9). Prima:
 *  - `ALL_CI_LABELS` fissa in tre punti (nodi d'ingresso, `labelFilter` APOC,
 *    archi): un CI di un tipo creato dal cliente non compariva nella topologia
 *    e non veniva **attraversato**, quindi spariva anche il pezzo di grafo
 *    dietro di lui — in silenzio;
 *  - `labelFromType`: `TYPE_TO_LABEL[t] ?? t`, cioè il NOME del tipo usato come
 *    etichetta (`load_balancer`), che non corrisponde a nessun nodo: il filtro
 *    per tipo tornava vuoto senza dire perché.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async () => null),
  clearCILabelCache:         vi.fn(),
}))

vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => [
    { name: 'application',   neo4jLabel: 'Application',  scope: 'base',   active: true },
    { name: 'server',        neo4jLabel: 'Server',       scope: 'base',   active: true },
    { name: 'load_balancer', neo4jLabel: 'LoadBalancer', scope: 'tenant', active: true },
  ]),
}))

// CM-11: la manutenzione è la semantica DEL CLIENTE, non il letterale `maintenance`.
vi.mock('../../../lib/ciLifecycle.js', () => ({
  resolveCILifecycleSemantics: vi.fn(async () => ({ retired: new Set(), maintenance: new Set(['in_revisione']), ignored: new Set() })),
  isMaintenanceLifecycle: (status: string | null | undefined, s: { maintenance: Set<string> }) => status != null && s.maintenance.has(status),
}))

const queries: { cypher: string; params: Record<string, unknown> }[] = []
let nodeRows: { get: (k: string) => unknown }[] = []

const mockSession = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      run: (cypher: string, params: Record<string, unknown>) => {
        queries.push({ cypher, params })
        return Promise.resolve({ records: cypher.includes('AS incidentCount') ? nodeRows : [] })
      },
    })),
  executeWrite: vi.fn(),
  close:        vi.fn(),
}

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return {
    ...actual,
    withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  }
})

vi.mock('../../../lib/workflowHelpers.js', () => ({
  getTerminalStepNames: vi.fn(async () => ['closed']),
}))

vi.mock('../../../lib/cache.js', () => ({
  cache: { get: vi.fn(() => undefined), set: vi.fn() },
}))

const { topologyResolvers } = await import('../topology.js')

const topology = topologyResolvers.Query.topology
const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }

const queryWith = (needle: string) => queries.find((q) => q.cypher.includes(needle))

beforeEach(() => { queries.length = 0; nodeRows = []; vi.clearAllMocks() })

describe('topology — etichette dal metamodello del tenant', () => {
  it('topologia completa: i nodi sono filtrati sulle etichette del tenant, tipo del cliente compreso', async () => {
    await topology(null, {}, ctx)
    const nodes = queryWith('ANY(lbl IN labels(ci) WHERE lbl IN $ciLabels)')
    expect(nodes, 'nessuna query sui nodi').toBeDefined()
    expect(nodes!.params['ciLabels']).toEqual(['Application', 'LoadBalancer', 'Server'])
  })

  it('ego-network: il labelFilter di APOC comprende il tipo del cliente (prima il traversal si fermava)', async () => {
    await topology(null, { selectedCiId: 'ci-1' }, ctx)
    const reach = queryWith('apoc.path.subgraphNodes')
    expect(reach).toBeDefined()
    expect(reach!.cypher).toContain("labelFilter:        '+Application|+LoadBalancer|+Server'")
    expect(reach!.params['ciLabels']).toEqual(['Application', 'LoadBalancer', 'Server'])
  })

  it('filtro per tipo: il NOME del tipo diventa la sua etichetta, anche per un tipo del cliente', async () => {
    await topology(null, { types: ['load_balancer', 'server'] }, ctx)
    const nodes = queryWith('ANY(lbl IN labels(ci) WHERE lbl IN $ciLabels)')
    expect(nodes!.params['ciLabels']).toEqual(['LoadBalancer', 'Server'])
  })

  it('un tipo che questo cliente non ha ferma la query dicendolo (prima: filtro muto, zero nodi)', async () => {
    await expect(topology(null, { types: ['bilanciatore'] }, ctx))
      .rejects.toThrow(/topology\(types:\): "bilanciatore" is not a CI type of this tenant/)
    expect(queries.some((q) => q.cypher.includes('labels(ci)'))).toBe(false)
  })
})

// ── Revisione del 15 set 2026 · CM-11 ─────────────────────────────────────────
describe('topology — stato e manutenzione dal cliente', () => {
  const node = (over: Record<string, unknown>) => {
    const m: Record<string, unknown> = { id: 'ci-1', name: 'srv', type: 'Server', status: null, health: null, environment: null, ownerGroup: null, incidentCount: 0, changeCount: 0, ...over }
    return { get: (k: string) => m[k] }
  }

  it('niente `coalesce(ci.status, \'active\')`: un CI senza stato non è «active»', async () => {
    nodeRows = [node({ status: null })]
    const out = await topology(null, {}, ctx) as { nodes: { status: string | null; inMaintenance: boolean }[] }
    expect(queryWith('AS incidentCount')!.cypher).not.toContain("'active'")
    expect(out.nodes[0]).toMatchObject({ status: null, inMaintenance: false })
  })

  it('«in manutenzione» è la semantica del cliente (qui `in_revisione`), non il letterale `maintenance`', async () => {
    nodeRows = [node({ status: 'in_revisione' }), node({ id: 'ci-2', status: 'maintenance' })]
    const out = await topology(null, {}, ctx) as { nodes: { id: string; inMaintenance: boolean }[] }
    expect(out.nodes.map((n) => [n.id, n.inMaintenance])).toEqual([['ci-1', true], ['ci-2', false]])
  })
})

