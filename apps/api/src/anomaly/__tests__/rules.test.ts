/**
 * ANOMALY_RULES — «un CI» è `:ConfigurationItem`, non un elenco di tipi
 * (ondata 6: A-9).
 *
 * Prima ogni regola girava su cinque etichette
 * (`Application|Server|Database|DatabaseInstance|Certificate`): fuori restavano
 * non solo i tipi creati dal cliente ma anche tre tipi **spediti col prodotto**
 * (`BusinessApplication`, `BusinessCapability`, `DynamicCIGroup`). Un CI fuori
 * da quell'elenco non era mai orfano, mai SPOF, mai senza owner: l'anomalia non
 * veniva trovata, in silenzio.
 *
 * Queste Cypher sono costanti di modulo, senza tenant e senza `await` (le
 * esegue l'engine per ogni tenant e anche `scripts/run-anomaly-scan.ts`):
 * `:ConfigurationItem` è la domanda giusta («è un CI?») e ogni CI porta quella
 * etichetta (migrazione `20260908_1010`).
 */
import { describe, it, expect } from 'vitest'
import { ANOMALY_RULES } from '../rules.js'

const byKey = (key: string) => {
  const rule = ANOMALY_RULES.find((r) => r.key === key)
  expect(rule, `regola ${key} assente`).toBeDefined()
  return rule!
}

describe('ANOMALY_RULES', () => {
  it('nessuna regola elenca i tipi di CI per sapere se un nodo è un CI', () => {
    for (const rule of ANOMALY_RULES) {
      expect(rule.cypher, rule.key).not.toMatch(/:Database\b|:DatabaseInstance\b/)
      expect(rule.cypher, rule.key).not.toMatch(/ci:Application OR ci:Server/)
    }
  })

  it('le regole generiche filtrano su :ConfigurationItem e sul tenant', () => {
    for (const key of ['orphan_ci', 'spof', 'dependency_cycle', 'missing_owner', 'risk_concentration']) {
      const rule = byKey(key)
      expect(rule.cypher, key).toContain('WHERE ci:ConfigurationItem')
      expect(rule.cypher, key).toContain('ci.tenant_id = $tenantId')
    }
  })

  it('spof e isolated_cluster contano come CI anche i vicini di un tipo qualsiasi', () => {
    expect(byKey('spof').cypher).toContain('WHERE dep:ConfigurationItem')
    expect(byKey('isolated_cluster').cypher).toContain('WHERE reached:ConfigurationItem')
    expect(byKey('isolated_cluster').cypher).toContain('WHERE pr:ConfigurationItem')
  })

  it('le due regole che parlano di tipi PRECISI restano sui loro tipi (è la loro semantica)', () => {
    // direzione sbagliata: Server -DEPENDS_ON-> Application
    expect(byKey('unauthorized_relation').cypher).toContain('MATCH (a:Server)-[:DEPENDS_ON]->(b:Application)')
    // candidato «foglia» del grafo spedito
    expect(byKey('isolated_cluster').cypher).toContain('AND (ci:Application OR ci:Certificate)')
  })

  it('ogni regola restituisce il contratto atteso dall\'engine', () => {
    for (const rule of ANOMALY_RULES) {
      for (const field of ['entityId', 'entityType', 'entitySubtype', 'entityName', 'description', 'params', 'severity']) {
        expect(rule.cypher, `${rule.key}/${field}`).toContain(`AS ${field}`)
      }
    }
  })

  /** Giro nel browser del 14 set 2026 (#57): «CI Senza Owner» anche con l'interfaccia inglese. */
  it('titoli e descrizioni sono inglesi: la frase per chi guarda la compone la pagina coi params', () => {
    const ITALIAN = /[àèéìòù]|\b(il|la|di|del|con|senza|rilevat|dipend|incidenti|nodi|raggiunge)\b/i
    for (const rule of ANOMALY_RULES) {
      expect(rule.title, rule.key).not.toMatch(ITALIAN)
      expect(rule.description, rule.key).not.toMatch(ITALIAN)
      const literals = [...rule.cypher.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
      expect(literals.filter((l) => ITALIAN.test(l)), rule.key).toEqual([])
    }
  })
})
