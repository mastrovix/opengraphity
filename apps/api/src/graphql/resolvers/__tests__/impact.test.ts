/**
 * impact.ts — il blast radius chiede le etichette dei CI al metamodello del
 * tenant (ondata 6: A-9 / C-2). Prima il predicato era la lista fissa **su
 * origine e impattati**: un CI di un tipo creato dal cliente non era né punto
 * di partenza né nodo impattato, quindi l'analisi d'impatto di una change
 * tornava «nessun impatto» senza dirlo, e i suoi ambienti non entravano nel
 * punteggio di rischio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async () => null),
  clearCILabelCache:         vi.fn(),
}))

vi.mock('../../../lib/workflowHelpers.js', () => ({
  getTerminalStepNames: vi.fn(async () => ['closed']),
}))

// C-3: anche i tipi di relazione percorribili vengono dal metamodello del
// cliente (sorgente unica con mappe e soppressione, lib/ciMetamodelForTenant.ts).
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({
  impactRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|BILANCIA|REALIZES|ENABLED_BY'),
}))

// Ondata 5 di «Nulla cablato»: pesi del cliente, livello = fascia del cliente,
// «produzione» = ambiente col punteggio più alto della matrice environment_risk.
vi.mock('../../../lib/impactWeights.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/impactWeights.js')>()
  return { ...actual, impactAnalysisWeights: vi.fn(async () => ({ ...actual.FACTORY_IMPACT_WEIGHTS, isDefault: false })) }
})
vi.mock('../../../lib/riskBands.js', () => ({
  MAX_RISK_SCORE: 100,
  riskBandOf: vi.fn(async (_t: string, score: number) => (score <= 30 ? 'basso' : score <= 60 ? 'medio' : 'alto')),
}))
vi.mock('../../../lib/environmentRisk.js', () => ({
  ENV_RISK_SCALE: ['0', '1', '2', '3'],
  environmentRiskScore: vi.fn(async (_t: string, env: string) => ({ prod: 3, collaudo: 1 } as Record<string, number>)[env] ?? 0),
}))

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...actual, ciTypeFromLabels: vi.fn(() => 'load_balancer') }
})

const { computeImpactAnalysis } = await import('../impact.js')

const queries: string[] = []
/** Righe restituite dalle query che contengono la chiave. */
let rowsFor: Array<[string, Array<Record<string, unknown>>]> = []

const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ run: (cypher: string) => {
      queries.push(cypher)
      const rows = rowsFor.find(([k]) => cypher.includes(k))?.[1] ?? []
      return Promise.resolve({ records: rows.map((r) => ({ get: (f: string) => r[f] })) })
    } })),
  executeWrite: vi.fn(),
  close: vi.fn(),
}

beforeEach(() => { queries.length = 0; rowsFor = []; vi.clearAllMocks() })

describe('computeImpactAnalysis', () => {
  it('origine E impattati usano il predicato del tenant (tipo del cliente compreso)', async () => {
    await computeImpactAnalysis(session as never, 'tenant-1', ['ci-1'])

    const blast = queries.find((q) => q.includes('shortestPath((ci)<-['))
    expect(blast, 'nessuna query di blast radius').toBeDefined()
    expect(blast).toContain('(ci:Application OR ci:LoadBalancer OR ci:Server)')
    expect(blast).toContain('(impacted:Application OR impacted:LoadBalancer OR impacted:Server)')
    // e la relazione aggiunta dal cliente viene percorsa (prima: sei tipi fissi)
    expect(blast).toContain('<-[:DEPENDS_ON|HOSTED_ON|BILANCIA|REALIZES|ENABLED_BY*1..5]-')

    // 4. ambienti dei CI toccati (entra nel punteggio di rischio)
    const envs = queries.find((q) => q.includes('RETURN ci.environment AS env'))
    expect(envs).toContain('ci:LoadBalancer')
  })

  it('nessuna query di dominio conserva un elenco di etichette scritto a mano', async () => {
    await computeImpactAnalysis(session as never, 'tenant-1', ['ci-1'])
    for (const q of queries) {
      expect(q).not.toMatch(/ci:DatabaseInstance OR ci:SslCertificate/)
    }
  })

  it('«produzione» viene dalla matrice del cliente e il livello è la sua fascia', async () => {
    rowsFor = [['RETURN ci.environment AS env', [{ env: 'prod' }, { env: 'collaudo' }, { env: 'production' }]]]
    const out = await computeImpactAnalysis(session as never, 'tenant-1', ['ci-1', 'ci-2', 'ci-3'])
    // solo `prod` vale 3 in questa matrice: il letterale `production` non conta più
    expect(out.breakdown.productionCIs).toBe(1)
    expect(out.riskScore).toBe(20)
    expect(out.riskLevel).toBe('basso')
  })
})
