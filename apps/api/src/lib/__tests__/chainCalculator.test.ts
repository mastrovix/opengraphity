/**
 * chainCalculator — il perimetro è `:ConfigurationItem`, non cinque etichette
 * (ondata 6: A-9).
 *
 * `chain` è un campo **base** di ogni CI e lo leggono i widget «per catena» e
 * l'analisi d'impatto. Con l'elenco fisso
 * (`Application|Server|Database|DatabaseInstance|Certificate`) i CI dei tipi
 * creati dal cliente — e anche i `BusinessApplication`, `BusinessCapability`,
 * `DynamicCIGroup` spediti col prodotto — restavano con `chain` nulla, fuori da
 * ogni conteggio; e il `total` del ricalcolo lo nascondeva, perché contava con
 * lo stesso filtro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queries: string[] = []
const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
const downstream = { ids: ['ci-1'] as string[] }
/** 24 Sep 2026: certificates follow their host — which ones the pass moves, which ones sit on the hosts. */
const certificateHosts = { moved: [] as string[], installed: [] as string[] }

const session = {
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) =>
    // CONTRATTO RINEGOZIATO (revisione totale · C-20): `calculateChain` non
    // restituisce più «Infrastructure» quando la query non torna righe — un CI
    // che non esiste è un errore, non una catena. Quindi la scrittura finta
    // deve restituire una riga con la catena, come fa il database.
    fn({ run: (cypher: string, params?: Record<string, unknown>) => {
      queries.push(cypher); calls.push({ cypher, params: params ?? {} })
      // The certificate pass moves only the certificates it finds: here, those listed in `certificateHosts`.
      if (cypher.includes('host.chain = $application')) return Promise.resolve({ records: certificateHosts.moved.map((id) => ({ get: () => id })) })
      return Promise.resolve({ records: [{ get: (k: string) => (k === 'id' ? 'ci-1' : 'Infrastructure') }] })
    } })),
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ run: (cypher: string, params?: Record<string, unknown>) => {
      queries.push(cypher); calls.push({ cypher, params: params ?? {} })
      // The certificates installed on the recomputed hosts.
      if (cypher.includes('h.id IN $hostIds')) return Promise.resolve({ records: [{ get: () => certificateHosts.installed }] })
      return Promise.resolve({ records: [{ get: (k: string) => (k === 'ids' ? downstream.ids : k === 'total' ? 7 : 3) }] })
    } })),
  close: vi.fn(),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session) }))
// CM-3: le relazioni lungo cui si propaga la catena vengono dal tenant.
vi.mock('../ciMetamodelForTenant.js', () => ({
  serviceRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|PROTEGGE'),
  serviceRelationshipTypesForTenant: vi.fn(async () => ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'PROTEGGE']),
  // The certificates are recognised by their service role, not by a label written here.
  serviceRolesForTenant: vi.fn(async () => new Map([['Server', 'infrastructure'], ['Certificate', 'certificate'], ['VpnToken', 'certificate']])),
}))

const { calculateAllChains, calculateChain, recalculateChainsFrom, CHAIN_DOWNSTREAM_MAX } = await import('../chainCalculator.js')

beforeEach(() => { queries.length = 0; calls.length = 0; certificateHosts.moved = []; certificateHosts.installed = []; vi.clearAllMocks() })

describe('calculateAllChains', () => {
  it('ogni statement parte da :ConfigurationItem, nessun elenco di tipi', async () => {
    const out = await calculateAllChains('tenant-1')
    // C-20: la famiglia singola è UNA scrittura sola (il tipo si risolve una
    // volta, col tipo del cliente che vince), poi l'ambiguo, poi i certificati
    // che seguono il loro host (24 Sep 2026), poi il conteggio.
    expect(queries).toHaveLength(4)
    for (const q of queries) {
      expect(q).toContain('MATCH (ci:ConfigurationItem {tenant_id: $tenantId})')
      expect(q).not.toMatch(/ci:Application OR ci:Server/)
    }
    // il conteggio finale usa lo STESSO perimetro delle scritture
    expect(queries[3]).toContain('RETURN count(ci) AS total')
    expect(out).toEqual({ total: 7, app: 3, infra: 3 })
    expect(session.close).toHaveBeenCalledOnce()
  })
})

describe('calculateChain', () => {
  it('C-20: il tipo è attivo, del tenant o base, e quello del cliente vince', async () => {
    await calculateChain('ci-1', 'tenant-1')
    expect(queries[0]).toContain("td.scope = 'base' OR (td.scope = 'tenant' AND td.tenant_id = $tenantId)")
    expect(queries[0]).toContain('td.active = true')
    expect(queries[0]).toContain("ORDER BY CASE WHEN td.scope = 'tenant' THEN 0 ELSE 1 END")
    // lo stesso vale per il tipo dei CI a monte
    expect(queries[0]).toContain("utd.scope = 'base' OR (utd.scope = 'tenant' AND utd.tenant_id = $tenantId)")
  })

  it('C-20: il ricalcolo generale decide da monte col TIPO, non con l-etichetta :Application', async () => {
    await calculateAllChains('tenant-1')
    const ambiguous = queries.find((q) => q.includes('WHERE ci.chain IS NULL'))
    expect(ambiguous).toBeDefined()
    expect(ambiguous).toContain('utd.neo4j_label IN labels(up)')
    expect(ambiguous).not.toContain('(app:Application {tenant_id: $tenantId})')
  })

  it('risolve il tipo dal metamodello per etichetta, senza filtrare per tipo', async () => {
    await calculateChain('ci-1', 'tenant-1')
    expect(queries[0]).toContain('MATCH (ci:ConfigurationItem {id: ciId, tenant_id: $tenantId})')
    expect(queries[0]).toContain('OPTIONAL MATCH (td:CITypeDefinition {neo4j_label: lbl})')
    expect(queries[0]).not.toMatch(/ci:Application OR ci:Server/)
  })

  it('CM-3: la catena segue le relazioni dei servizi del tenant, comprese quelle del cliente', async () => {
    await calculateChain('ci-1', 'tenant-1')
    expect(queries[0]).toContain('(upstream)-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|PROTEGGE*1..10]->(ci)')
    await calculateAllChains('tenant-1')
    expect(queries.some((q) => q.includes('[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|PROTEGGE*0..10]'))).toBe(true)
  })
})

/**
 * Owner, 24 Sep 2026: a certificate installed on a server or an instance alone
 * has nothing above it, and stayed outside every application chain even when
 * its host runs one. It now takes its host's chain.
 */
describe('a certificate follows where it is installed', () => {
  it('after the chains of the CIs, the certificates among them take Application from a host in an application chain', async () => {
    certificateHosts.moved = ['cert-1']
    const chain = await calculateChain('cert-1', 'tenant-1')
    const pass = calls.find((c) => c.cypher.includes('host.chain = $application'))!
    expect(pass.cypher).toContain('MATCH (ci:ConfigurationItem {tenant_id: $tenantId})')
    expect(pass.cypher).toContain('WHERE type(r) IN $relTypes AND host.chain = $application')
    expect(pass.cypher).not.toContain('${')
    expect(pass.params).toMatchObject({
      tenantId: 'tenant-1', ids: ['cert-1'], certificateLabels: ['Certificate', 'VpnToken'],
      relTypes: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'PROTEGGE'], application: 'Application',
    })
    // The pass runs AFTER the CI's own chain: the host's must be set first.
    expect(queries.indexOf(pass.cypher)).toBeGreaterThan(queries.findIndex((q) => q.includes('UNWIND $ciIds AS ciId')))
    expect(chain).toBe('Application')
  })

  it('a certificate its host does not bring into a chain keeps the chain computed for it', async () => {
    await expect(calculateChain('ci-1', 'tenant-1')).resolves.toBe('Infrastructure')
  })

  it('the whole tenant: the pass covers every certificate (ids null), after the ambiguous types', async () => {
    await calculateAllChains('tenant-1')
    const pass = calls.find((c) => c.cypher.includes('host.chain = $application'))!
    expect(pass.params['ids']).toBeNull()
    expect(queries.indexOf(pass.cypher)).toBeGreaterThan(queries.findIndex((q) => q.includes('WHERE ci.chain IS NULL')))
  })

  it('a host\'s chain changed: the certificates installed on it are recomputed with it', async () => {
    downstream.ids = ['srv-1', 'app-1']
    certificateHosts.installed = ['cert-9']
    await expect(recalculateChainsFrom('srv-1', 'tenant-1')).resolves.toBe(3)
    const onHosts = calls.find((c) => c.cypher.includes('h.id IN $hostIds'))!
    expect(onHosts.params).toMatchObject({ hostIds: ['srv-1', 'app-1'], certificateLabels: ['Certificate', 'VpnToken'] })
    const recomputed = calls.find((c) => c.cypher.includes('UNWIND $ciIds AS ciId'))!
    expect(recomputed.params['ciIds']).toEqual(['srv-1', 'app-1', 'cert-9'])
  })
})

// Review of 23 Sep 2026: a relationship change recomputed its two ends; the chain flows downstream.
describe('recalculateChainsFrom', () => {
  it('the CI and every CI downstream of it within 10 hops, in one write', async () => {
    downstream.ids = ['ci-1', 'ci-2', 'ci-3']
    await expect(recalculateChainsFrom('ci-1', 'tenant-1')).resolves.toBe(3)
    expect(queries[0]).toContain('OPTIONAL MATCH (ci)-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|PROTEGGE*1..10]->(d)')
    expect(queries[0]).toContain('collect(DISTINCT d.id)')
    const write = queries.find((q) => q.includes('UNWIND $ciIds AS ciId'))!
    // Each upstream CI once: no path is walked twice.
    expect(write).toContain('WITH DISTINCT upstream')
  })

  it('more CIs downstream than the cap: the whole tenant is recomputed in its batch', async () => {
    downstream.ids = Array.from({ length: CHAIN_DOWNSTREAM_MAX + 1 }, (_, i) => `ci-${i}`)
    await recalculateChainsFrom('ci-0', 'tenant-1')
    expect(queries.some((q) => q.includes('UNWIND $ciIds AS ciId'))).toBe(false)
    expect(queries.some((q) => q.includes('RETURN count(ci) AS total'))).toBe(true)
  })
})

