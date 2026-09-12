/**
 * `addAffectedCI` (incident) e `addCIToProblem` (problem) — ondata 6, A-9 e la
 * lezione di C-2.
 *
 * Due difetti nello stesso punto:
 *  1. il predicato «è un CI» era la lista fissa di quindici etichette, quindi
 *     un CI di un tipo creato dal cliente non veniva trovato;
 *  2. quando le regole ITIL limitano i tipi, le etichette erano calcolate con
 *     una PascalCase **fatta a mano** sul nome del tipo (`load_balancer` →
 *     `LoadBalancer`): un tipo la cui etichetta non segue quella convenzione
 *     dava un `MERGE` che non scriveva niente;
 *  3. e in ogni caso **nessuno leggeva l'esito del MERGE**: zero righe erano
 *     indistinguibili dal successo, e la mutation restituiva il ticket intatto
 *     come se il collegamento ci fosse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async () => null),
  clearCILabelCache:         vi.fn(),
}))

// Il tipo del cliente ha un'etichetta che NON è il PascalCase del nome: è il
// caso che la conversione a mano sbagliava in silenzio.
vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => [
    { name: 'server',        neo4jLabel: 'Server',       scope: 'base',   active: true },
    { name: 'load_balancer', neo4jLabel: 'LoadBalancer', scope: 'tenant', active: true },
  ]),
}))

const allowedTypes: string[] = []
vi.mock('../itilRelations.js', () => ({
  getAllowedCILabels: vi.fn(async () => allowedTypes),
  itilRelationsResolvers: {},
}))

let linked = 1
const writes: { cypher: string; params: Record<string, unknown> }[] = []

const session = {
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      run: (cypher: string, params: Record<string, unknown>) => {
        writes.push({ cypher, params })
        return Promise.resolve({ records: [{ get: () => linked }] })
      },
    })),
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ run: () => Promise.resolve({ records: [{ get: () => ({ id: 'inc-1' }) }] }) })),
  close: vi.fn(),
}

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...actual, withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)) }
})

vi.mock('@opengraphity/neo4j', () => ({
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(async () => ({ props: { id: 'prb-1', title: 'T', status: 'new' } })),
  getSession:  vi.fn(),
  toNumber:    (v: unknown) => Number(v ?? 0),
}))

vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))

const { incidentResolvers } = await import('../incident.js')
const { problemResolvers } = await import('../problem.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'u1', userEmail: 'u@x', role: 'operator' }

beforeEach(() => { writes.length = 0; linked = 1; allowedTypes.length = 0; vi.clearAllMocks() })

describe('addAffectedCI (incident)', () => {
  it('senza regole ITIL il predicato viene dal metamodello del tenant', async () => {
    await incidentResolvers.Mutation.addAffectedCI(null, { incidentId: 'inc-1', ciId: 'ci-1' }, ctx)
    expect(writes[0]!.cypher).toContain('(ci:Application OR ci:LoadBalancer OR ci:Server)')
    expect(writes[0]!.cypher).toContain('RETURN count(r) AS linked')
  })

  it('con regole ITIL le etichette vengono dal metamodello, non da una PascalCase a mano', async () => {
    allowedTypes.push('load_balancer')
    await incidentResolvers.Mutation.addAffectedCI(null, { incidentId: 'inc-1', ciId: 'ci-1' }, ctx)
    expect(writes[0]!.cypher).toContain('ANY(label IN labels(ci) WHERE label IN $allowedLabels)')
    expect(writes[0]!.params['allowedLabels']).toEqual(['LoadBalancer'])
  })

  it('una regola ITIL su un tipo che il cliente non ha si ferma dicendolo', async () => {
    allowedTypes.push('bilanciatore')
    await expect(incidentResolvers.Mutation.addAffectedCI(null, { incidentId: 'inc-1', ciId: 'ci-1' }, ctx))
      .rejects.toThrow(/"bilanciatore" non è un tipo di CI di questo cliente/)
    expect(writes).toHaveLength(0)
  })

  it('zero collegamenti → errore esplicito (prima: successo silenzioso)', async () => {
    linked = 0
    await expect(incidentResolvers.Mutation.addAffectedCI(null, { incidentId: 'inc-1', ciId: 'ci-x' }, ctx))
      .rejects.toThrow(/CI ci-x non collegato all'incident/)
  })
})

describe('addCIToProblem (problem)', () => {
  it('predicato dal tenant, righe contate', async () => {
    await problemResolvers.Mutation.addCIToProblem(null, { problemId: 'prb-1', ciId: 'ci-1' }, ctx)
    expect(writes[0]!.cypher).toContain('(ci:Application OR ci:LoadBalancer OR ci:Server)')
    expect(writes[0]!.cypher).toContain('RETURN count(r) AS linked')
  })

  it('zero collegamenti → errore esplicito', async () => {
    linked = 0
    await expect(problemResolvers.Mutation.addCIToProblem(null, { problemId: 'prb-1', ciId: 'ci-x' }, ctx))
      .rejects.toThrow(/CI ci-x non collegato al problem/)
  })
})
