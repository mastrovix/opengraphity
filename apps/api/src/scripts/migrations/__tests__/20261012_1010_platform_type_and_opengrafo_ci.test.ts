/**
 * THE PLATFORM TYPE, AND OPENGRAFO AS A CI OF EVERY TENANT (26 Sep 2026).
 *
 * What a user loses if this regresses: a Platform type written over one an
 * organization already has; a tenant left without the OpenGrafo CI, so the
 * problems of the remedies reach no one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ensure = vi.hoisted(() => vi.fn(async () => ({ teamCreated: true, members: 2, ciCreated: true })))
vi.mock('../../../lib/opengrafoSystemCI.js', () => ({ ensureOpenGrafoSystemCI: ensure }))

const { platformTypeAndOpenGrafoCI } = await import('../20261012_1010_platform_type_and_opengrafo_ci.js')

let typeCreated: boolean
const calls: string[] = []
const session = {
  run: vi.fn(async (q: string) => {
    calls.push(q)
    if (q.includes('CREATE (t:CITypeDefinition')) return { records: typeCreated ? [{ get: () => 'id' }] : [] }
    if (q.includes('MATCH (t:Tenant)')) return { records: ['c-one', 'demo'].map((id) => ({ get: () => id })) }
    return { records: [] }
  }),
}

beforeEach(() => { calls.length = 0; ensure.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => undefined) })

describe('20261012_1010_platform_type_and_opengrafo_ci', () => {
  it('creates the type with both families, as a component, only where no type has that name or label', async () => {
    typeCreated = true
    await platformTypeAndOpenGrafoCI.up(session as never)
    const create = calls.find((q) => q.includes('CREATE (t:CITypeDefinition'))!
    expect(create).toContain('OPTIONAL MATCH (old:CITypeDefinition) WHERE old.name = $name OR old.neo4j_label = $neo4jLabel')
    expect(session.run.mock.calls.find(([q]) => q === create)![1]).toMatchObject({
      name: 'platform', neo4jLabel: 'Platform', chainFamilies: '["Application","Infrastructure"]', serviceRole: 'component',
    })
    expect(calls.some((q) => q.includes('CIRelationDefinition'))).toBe(true)
    expect(calls.some((q) => q.includes('CISystemRelationDefinition'))).toBe(true)
  })

  it('a type already there: its relations are not written again', async () => {
    typeCreated = false
    await platformTypeAndOpenGrafoCI.up(session as never)
    expect(calls.some((q) => q.includes('CIRelationDefinition'))).toBe(false)
  })

  it('every tenant gets its OpenGrafo CI and team', async () => {
    typeCreated = false
    await platformTypeAndOpenGrafoCI.up(session as never)
    expect(ensure.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['c-one', 'demo'])
  })
})
