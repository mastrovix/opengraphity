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
    fn({ run: (cypher: string) => { queries.push(cypher); return Promise.resolve({ records: [] }) } })),
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ run: (cypher: string) => { queries.push(cypher); return Promise.resolve({ records: [{ get: (k: string) => (k === 'total' ? 7 : 3) }] }) } })),
  close: vi.fn(),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session) }))

const { calculateAllChains, calculateChain } = await import('../chainCalculator.js')

beforeEach(() => { queries.length = 0; vi.clearAllMocks() })

describe('calculateAllChains', () => {
  it('ogni statement parte da :ConfigurationItem, nessun elenco di tipi', async () => {
    const out = await calculateAllChains('tenant-1')
    expect(queries).toHaveLength(4)   // due SET per famiglia singola, uno ambiguo, uno di conteggio
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
  it('risolve il tipo dal metamodello per etichetta, senza filtrare per tipo', async () => {
    await calculateChain('ci-1', 'tenant-1')
    expect(queries[0]).toContain('MATCH (ci {id: $ciId, tenant_id: $tenantId})')
    expect(queries[0]).toContain('OPTIONAL MATCH (td:CITypeDefinition {neo4j_label: lbl})')
    expect(queries[0]).not.toMatch(/ci:Application OR ci:Server/)
  })
})
