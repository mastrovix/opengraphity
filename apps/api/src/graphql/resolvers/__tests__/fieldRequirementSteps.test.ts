/**
 * Personalizzazioni, ondata 8 — A8-4 (B-21): una regola di obbligatorietà per
 * passo deve nominare un passo che ESISTE nel workflow di questo cliente.
 *
 * `FieldRequirementRule.workflow_step` era testo libero: una regola «la data di
 * rilascio è obbligatoria entrando in `scheduled`» scritta su un tenant che
 * chiama quel passo «in_calendario» restava nel pannello, apparentemente
 * attiva, e non si applicava a nessuna transizione — silenziosamente. Il
 * rifiuto elenca i passi veri, così chi la configura sa cosa scegliere.
 * `workflow_step = null` (regola globale) resta sempre valido.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

interface Call { cypher: string; params: Record<string, unknown> }
const calls: Call[] = []
let results: Array<{ records: Array<{ get: (k: string) => unknown }> }> = []
const nextResult = () => results.shift() ?? { records: [] }

const mockSession = {
  executeRead:  vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async (cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params }); return nextResult() },
  })),
  executeWrite: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async (cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params }); return nextResult() },
  })),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('@opengraphity/neo4j', () => ({
  runQuery:    vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/requireRole.js', () => ({ requireRole: vi.fn() }))
// I passi del workflow di questo cliente: nomi SUOI, nessuno di fabbrica.
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn(async () => [
    { name: 'valutazione' }, { name: 'cab_settimanale' }, { name: 'in_calendario' }, { name: 'archiviata' },
  ]),
}))

const { fieldRulesResolvers } = await import('../fieldRules.js')
const { getWorkflowSteps } = await import('../../../lib/workflowHelpers.js')

const ctx: GraphQLContext = { tenantId: 'c-two', userId: 'user-1', userEmail: 'u@test.io', role: 'admin' }
const set = (args: Record<string, unknown>) =>
  fieldRulesResolvers.Mutation.setFieldRequirement(null, args as never, ctx)

beforeEach(() => { calls.length = 0; results = []; vi.clearAllMocks() })

describe('setFieldRequirement — il passo citato deve esistere', () => {
  it('un passo rinominato dal cliente è accettato e la regola si scrive', async () => {
    await set({ entityType: 'change', fieldName: 'planned_start', required: true, workflowStep: 'in_calendario' })
    expect(calls.some((c) => c.cypher.includes('CREATE (r:FieldRequirementRule'))).toBe(true)
    expect(calls.find((c) => c.cypher.includes('CREATE (r:FieldRequirementRule'))!.params['workflowStep']).toBe('in_calendario')
  })

  it('un passo che non esiste → rifiuto che elenca i passi veri, senza scrivere', async () => {
    const err = await set({ entityType: 'change', fieldName: 'planned_start', required: true, workflowStep: 'scheduled' })
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err).toBeInstanceOf(GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('Lo step "scheduled" non esiste nel workflow "change"')
    expect(err!.message).toContain('valutazione, cab_settimanale, in_calendario, archiviata')
    expect(err!.extensions['availableSteps']).toEqual(['valutazione', 'cab_settimanale', 'in_calendario', 'archiviata'])
    expect(calls.some((c) => c.cypher.includes('CREATE'))).toBe(false)
  })

  it('regola GLOBALE (workflowStep null o vuoto): nessuna lettura dei passi, nessun rifiuto', async () => {
    await set({ entityType: 'change', fieldName: 'why', required: true, workflowStep: null })
    await set({ entityType: 'change', fieldName: 'why', required: true })
    expect(getWorkflowSteps).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.cypher.includes('CREATE (r:FieldRequirementRule'))).toHaveLength(2)
  })

  it('tenant senza definizione di workflow → il rifiuto lo dice invece di elencare il vuoto', async () => {
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([])
    const err = await set({ entityType: 'problem', fieldName: 'root_cause', required: true, workflowStep: 'resolved' })
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('non ha ancora una definizione di workflow per "problem"')
  })
})
