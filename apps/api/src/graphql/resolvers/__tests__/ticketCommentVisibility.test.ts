/**
 * Revisione del 14 set 2026 · F1: chi scrive dal dettaglio di incident e
 * problem sceglie se è una nota interna o una risposta pubblica; senza scelta è
 * interna — un testo dello staff non diventa visibile all'utente finale per
 * distrazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, _c: string, p: Record<string, unknown>) => [{
    comment: { id: 'c-1', text: p['text'], is_internal: p['isInternal'], author_id: p['authorId'], created_at: 'a', updated_at: 'a' },
    author: { id: 'u1', name: 'Anna', email: 'a@x', role: 'operator' },
  }]),
  runQueryOne: vi.fn(), getSession: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ci-utils.js')>()),
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))

const { incidentResolvers } = await import('../incident.js')
const { problemResolvers } = await import('../problem.js')
const { runQuery } = await import('@opengraphity/neo4j')
const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'a@x', role: 'operator' }

beforeEach(() => vi.clearAllMocks())

describe('visibilità dei commenti dello staff', () => {
  it('incident: senza scelta è interna, con isInternal false è pubblica', async () => {
    const internal = await incidentResolvers.Mutation.addIncidentComment(undefined, { id: 'i1', text: 'nota' }, ctx)
    expect(internal.isInternal).toBe(true)
    const pub = await incidentResolvers.Mutation.addIncidentComment(undefined, { id: 'i1', text: 'risposta', isInternal: false }, ctx)
    expect(pub.isInternal).toBe(false)
    const writes = vi.mocked(runQuery).mock.calls.filter((c) => String(c[1]).includes('CREATE (c:Comment'))
    expect(writes[1]![2]).toMatchObject({ isInternal: false, entityId: 'i1' })
  })

  it('problem: stesso modello Comment, stessa regola', async () => {
    const c = await problemResolvers.Mutation.addProblemComment(undefined, { problemId: 'p1', text: 'nota' }, ctx)
    expect(c.isInternal).toBe(true)
    const write = vi.mocked(runQuery).mock.calls.find((call) => String(call[1]).includes('CREATE (c:Comment'))!
    expect(String(write[1])).toContain('MATCH (e:Problem')
  })
})
