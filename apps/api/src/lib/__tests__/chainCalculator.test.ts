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

const session = {
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) =>
    // CONTRATTO RINEGOZIATO (revisione totale · C-20): `calculateChain` non
    // restituisce più «Infrastructure» quando la query non torna righe — un CI
    // che non esiste è un errore, non una catena. Quindi la scrittura finta
    // deve restituire una riga con la catena, come fa il database.
    fn({ run: (cypher: string) => { queries.push(cypher); return Promise.resolve({ records: [{ get: () => 'Infrastructure' }] }) } })),
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ run: (cypher: string) => { queries.push(cypher); return Promise.resolve({ records: [{ get: (k: string) => (k === 'total' ? 7 : 3) }] }) } })),
  close: vi.fn(),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session) }))
// CM-3: le relazioni lungo cui si propaga la catena vengono dal tenant.
vi.mock('../ciMetamodelForTenant.js', () => ({ serviceRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|PROTEGGE') }))

const { calculateAllChains, calculateChain } = await import('../chainCalculator.js')

beforeEach(() => { queries.length = 0; vi.clearAllMocks() })

describe('calculateAllChains', () => {
  it('ogni statement parte da :ConfigurationItem, nessun elenco di tipi', async () => {
    const out = await calculateAllChains('tenant-1')
    // C-20: la famiglia singola è UNA scrittura sola (il tipo si risolve una
    // volta, col tipo del cliente che vince), poi l'ambiguo, poi il conteggio.
    expect(queries).toHaveLength(3)
    for (const q of queries) {
      expect(q).toContain('MATCH (ci:ConfigurationItem {tenant_id: $tenantId})')
      expect(q).not.toMatch(/ci:Application OR ci:Server/)
    }
    // il conteggio finale usa lo STESSO perimetro delle scritture
    expect(queries[2]).toContain('RETURN count(ci) AS total')
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
    expect(queries[0]).toContain('MATCH (ci {id: $ciId, tenant_id: $tenantId})')
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
