/**
 * B-06 / B-07 — the CI ⇄ ticket relationships used by what-if and topology
 * are the real ones:
 *   (Incident)-[:AFFECTED_BY]->(ci)   incidentService.createIncident / addAffectedCI
 *   (Change)-[:AFFECTS_CI]->(ci)      changeMutations / changeCreationService
 * A wrong type here does not throw — it silently counts 0 — so the Cypher is
 * pinned by name.
 */
import { describe, it, expect, vi } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))

// Il metamodello del tenant: `lib/ciTypeNameToLabel.ts` ci risolve il verso
// nome del tipo → etichetta (prima era una tabella fissa o una PascalCase a mano).
vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => [
    { name: 'application',   neo4jLabel: 'Application',  scope: 'base',   active: true },
    { name: 'server',        neo4jLabel: 'Server',       scope: 'base',   active: true },
    { name: 'load_balancer', neo4jLabel: 'LoadBalancer', scope: 'tenant', active: true },
  ]),
}))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/cache.js', () => ({ cache: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getTerminalStepNames: vi.fn() }))

const { OPEN_INCIDENTS_ON_CIS_CYPHER } = await import('../whatif.js')
const { TICKET_COUNT_MATCHES } = await import('../topology.js')

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('whatif.openIncidents (B-06)', () => {
  it('counts incidents via AFFECTED_BY, labelled and tenant-scoped', () => {
    const q = squash(OPEN_INCIDENTS_ON_CIS_CYPHER)
    expect(q).toContain('MATCH (ci)<-[:AFFECTED_BY]-(inc:Incident {tenant_id: $tenantId})')
    expect(q).toContain('ci.id IN $impactedIds')
    expect(q).toContain('NOT inc.status IN $terminalSteps')
    expect(q).not.toMatch(/\[:AFFECTS\]/)
  })
})

describe('topology.changeCount (B-07)', () => {
  it('counts changes via AFFECTS_CI and incidents via AFFECTED_BY', () => {
    const q = squash(TICKET_COUNT_MATCHES)
    expect(q).toContain('OPTIONAL MATCH (i:Incident)-[:AFFECTED_BY]->(ci) WHERE i.tenant_id = $tenantId')
    expect(q).toContain('OPTIONAL MATCH (ch:Change)-[:AFFECTS_CI]->(ci) WHERE ch.tenant_id = $tenantId')
    expect(q).toContain('coalesce(ch.deleted, false) = false')
    expect(q).not.toMatch(/\[:AFFECTS\]/)
  })
})
