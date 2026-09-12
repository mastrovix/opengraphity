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

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...actual, ciTypeFromLabels: vi.fn(() => 'load_balancer') }
})

const { computeImpactAnalysis } = await import('../impact.js')

const queries: string[] = []

const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ run: (cypher: string) => { queries.push(cypher); return Promise.resolve({ records: [] }) } })),
  executeWrite: vi.fn(),
  close: vi.fn(),
}

beforeEach(() => { queries.length = 0; vi.clearAllMocks() })

describe('computeImpactAnalysis', () => {
  it('origine E impattati usano il predicato del tenant (tipo del cliente compreso)', async () => {
    await computeImpactAnalysis(session as never, 'tenant-1', ['ci-1'])

    const blast = queries.find((q) => q.includes('MATCH path = (ci)<-['))
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
})
