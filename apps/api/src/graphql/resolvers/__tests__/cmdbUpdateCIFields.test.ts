import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  runQuery: vi.fn(),
  runQueryOne: vi.fn(),
}))

const { buildCIFieldUpdates, cmdbResolvers } = await import('../cmdb.js')
const { getSession, runQuery } = await import('@opengraphity/neo4j')

const NOW = '2026-09-08T00:00:00.000Z'

function expectBadInput(fn: () => unknown, part: string) {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(GraphQLError)
  expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
  expect((thrown as GraphQLError).message).toContain(part)
}

describe('buildCIFieldUpdates (B-01)', () => {
  it('maps base fields + camelCase custom keys to a parameter object', () => {
    expect(buildCIFieldUpdates({ name: 'web-01', customFields: JSON.stringify({ ipAddress: '10.0.0.1', rack_unit: 12 }) }, NOW))
      .toEqual({ updated_at: NOW, name: 'web-01', ip_address: '10.0.0.1', rack_unit: 12 })
  })

  const injections: Array<[string, string, string]> = [
    ['SET injection via key',        JSON.stringify({ 'x = 1 SET ci.tenant_id': 'evil' }), 'invalid field name'],
    ['closing brace / comment',      JSON.stringify({ 'foo}) DETACH DELETE ci //': 1 }),     'invalid field name'],
    ['backtick',                     JSON.stringify({ 'a`b': 1 }),                           'invalid field name'],
    ['space',                        JSON.stringify({ 'a b': 1 }),                           'invalid field name'],
    ['leading underscore (PascalCase)', JSON.stringify({ Foo: 1 }),                          'invalid field name'],
    ['reserved tenant_id',           JSON.stringify({ tenant_id: 'other' }),                 'system-managed'],
    ['reserved tenantId (camel)',    JSON.stringify({ tenantId: 'other' }),                  'system-managed'],
    ['reserved id',                  JSON.stringify({ id: 'x' }),                            'system-managed'],
    ['reserved created_at',          JSON.stringify({ created_at: 'x' }),                    'system-managed'],
    ['reserved labels',              JSON.stringify({ labels: ['Admin'] }),                  'system-managed'],
    ['not JSON',                     '{oops',                                                'not valid JSON'],
    ['JSON array',                   '[1,2]',                                                'must be a JSON object'],
  ]
  it.each(injections)('rejects %s', (_n, customFields, part) => {
    expectBadInput(() => buildCIFieldUpdates({ customFields }, NOW), part)
  })
})

describe('updateCIFields resolver', () => {
  it('uses SET ci += $updates with a parameter map (no key in the query text)', async () => {
    const session = { close: vi.fn() }
    vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'ci-1', name: 'web-01', tenant_id: 't1' } }] as never)

    const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' as const }
    await cmdbResolvers.Mutation.updateCIFields(undefined, {
      id: 'ci-1', input: { name: 'web-01', customFields: JSON.stringify({ ipAddress: '10.0.0.1' }) },
    }, ctx)

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('SET ci += $updates')
    expect(cypher).not.toContain('ip_address')
    expect(params).toMatchObject({ id: 'ci-1', tenantId: 't1', updates: { name: 'web-01', ip_address: '10.0.0.1' } })
  })

  it('rejects an injected key before touching the database', async () => {
    vi.mocked(runQuery).mockClear()
    const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' as const }
    await expect(cmdbResolvers.Mutation.updateCIFields(undefined, {
      id: 'ci-1', input: { customFields: JSON.stringify({ 'x = 1 SET ci.tenant_id': 'evil' }) },
    }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(runQuery).not.toHaveBeenCalled()
  })
})
