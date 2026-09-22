/**
 * The metamodel name gate: the corners the main suite does not reach.
 *
 * Why it matters: when a new CI type name collides with an existing one, the
 * refusal must say WHERE the taken name comes from, including for a type
 * whose scope is unknown (older rows have none) — otherwise the admin reads
 * a refusal with a blank origin and cannot tell what to rename. And only
 * name-rule failures become user-facing BAD_USER_INPUT: any other failure
 * (a bug in the gate) must surface as itself, not be dressed up as the
 * user's mistake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const realAssert = { fn: null as null | ((...a: unknown[]) => unknown) }
vi.mock('@opengraphity/schema-generator', async (orig) => {
  const mod = await orig<typeof import('@opengraphity/schema-generator')>()
  return {
    ...mod,
    assertCIFieldName: vi.fn((...a: unknown[]) => (realAssert.fn ?? (mod.assertCIFieldName as (...x: unknown[]) => unknown))(...a)),
  }
})

const { assertNewCITypeName, assertNewCIFieldName, resetBaseSchemaNamesCache, reservedNamesFromSDL } = await import('../metamodelNames.js')
const { ValidationError } = await import('../errors.js')

beforeEach(() => { resetBaseSchemaNamesCache(); realAssert.fn = null })

describe('assertNewCITypeName — origin of a taken name', () => {
  it('describes a type with no scope as "a CI type that already exists"', () => {
    let err: unknown
    try { assertNewCITypeName('firewall', [{ name: 'firewall', scope: null }]) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as GraphQLError).message).toContain('a CI type that already exists')
  })

  it('describes a tenant type as "a CI type of yours"', () => {
    expect(() => assertNewCITypeName('firewall', [{ name: 'firewall', scope: 'tenant' }]))
      .toThrow('a CI type of yours')
  })

  it('accepts a free name', () => {
    expect(assertNewCITypeName('load_balancer', [{ name: 'firewall', scope: 'tenant' }])).toBe('load_balancer')
  })
})

describe('reservedNamesFromSDL — the less common SDL shapes', () => {
  it('reserves Subscription as a type but does not mistake its fields for queries or mutations', () => {
    const r = reservedNamesFromSDL('type Subscription { ticketChanged: String }')
    expect(r.types.has('subscription')).toBe(true)
    expect(r.queryFields.has('ticketchanged')).toBe(false)
    expect(r.mutationFields.has('ticketchanged')).toBe(false)
  })

  it('keeps the first origin when an `extend type` repeats a name, and ignores non-type definitions', () => {
    const r = reservedNamesFromSDL(
      'type Query { widget: String }\nextend type Query { Widget: Int, other: Int }\nscalar DateTime\ndirective @auth on FIELD_DEFINITION',
    )
    expect(r.queryFields.get('widget')).toBe('widget is a query of the base schema')
    expect(r.queryFields.has('other')).toBe(true)
    expect(r.types.get('query')).toBe('Query is a type of the base schema')
    // A scalar has no fields but its name is still taken; a directive is not a type.
    expect(r.types.has('datetime')).toBe(true)
    expect(r.types.has('auth')).toBe(false)
  })

  it('reads several SDL documents into one list', () => {
    const r = reservedNamesFromSDL('type Mutation { a: Int }', 'type Mutation { b: Int }')
    expect([...r.mutationFields.keys()].sort()).toEqual(['a', 'b'])
  })
})

describe('assertNewCIFieldName — only name-rule failures become user errors', () => {
  it('rethrows an unexpected error unchanged', () => {
    const boom = new TypeError('gate bug')
    realAssert.fn = () => { throw boom }
    expect(() => assertNewCIFieldName('ip_address')).toThrow(boom)
  })
})
