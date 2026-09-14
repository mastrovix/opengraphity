/**
 * Revisione del 14 set 2026 · IT-1.
 *
 *  1. `problems(search)` costruiva una regex con il testo dell'utente
 *     (`=~ '(?i).*' + search + '.*'`): dal vivo «C++ (» dava «Invalid Regex:
 *     Unclosed group». Ora è CONTAINS con il testo passato come parametro.
 *  2. `knownErrors` filtrava `status: 'known_error'`, il NOME del passo: un
 *     cliente che lo rinominava vedeva la KEDB vuota. Ora chiede i passi con
 *     scopo `known_error`, e senza nessuno lo dice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

const queries: { cypher: string; params: Record<string, unknown> }[] = []

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    queries.push({ cypher, params })
    return cypher.includes('count(p)') ? [{ total: 0 }] : []
  }),
  runQueryOne: vi.fn(),
  getSession:  vi.fn(),
  toNumber:    (v: unknown) => Number(v ?? 0),
}))

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...actual, withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})) }
})

let purposeSteps: string[] = ['documented']
vi.mock('../../../lib/workflowHelpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/workflowHelpers.js')>()
  return { ...actual, getStepNamesByPurpose: vi.fn(async () => purposeSteps) }
})

vi.mock('../../../lib/schemaFields.js', () => ({ getScalarFields: vi.fn(() => new Set(['title'])) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))

const { problemResolvers } = await import('../problem.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'u1', userEmail: 'u@x', role: 'operator' }
const info = { schema: {} } as never

beforeEach(() => { queries.length = 0; purposeSteps = ['documented'] })

describe('problems(search)', () => {
  it('passa il testo così com\'è e usa CONTAINS, mai una regex', async () => {
    await problemResolvers.Query.problems(undefined, { search: 'C++ (' }, ctx, info)
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) {
      expect(q.cypher).not.toContain('=~')
      expect(q.params['search']).toBe('C++ (')
      expect(q.cypher).toContain('CONTAINS toLower($search)')
    }
  })
})

describe('knownErrors', () => {
  it('elenca i problem dei passi con scopo known_error, qualunque sia il loro nome', async () => {
    await problemResolvers.Query.knownErrors(undefined, {}, ctx)
    expect(queries).toHaveLength(1)
    expect(queries[0]!.cypher).not.toContain("'known_error'")
    expect(queries[0]!.params['steps']).toEqual(['documented'])
  })

  it('senza nessun passo con quello scopo si ferma e lo dice', async () => {
    purposeSteps = []
    await expect(problemResolvers.Query.knownErrors(undefined, {}, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.problem.noKnownErrorStep' } } })
    expect(queries).toHaveLength(0)
  })
})
