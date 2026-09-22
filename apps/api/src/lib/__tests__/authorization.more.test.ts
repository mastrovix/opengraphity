/**
 * The authorization policy wraps EVERY root field, so its edges are the
 * product's security perimeter:
 *  - a field with no rule must fail loudly as a PRODUCT defect (plain Error),
 *    never as a ForbiddenError that a user would read as "you lack a role" and
 *    an operator would never investigate;
 *  - the wrapper must refuse before the resolver runs (a resolver with side
 *    effects that ran first would leak the write even though the caller got
 *    a 403);
 *  - customer-named CI fields (`Query.servers`, `Mutation.createServer`) are
 *    covered by the dynamic CI permissions, not left open;
 *  - the startup check must reject both a policy row naming a field that no
 *    longer exists and a field no row decides, otherwise a renamed mutation
 *    silently loses its guard.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Permission } from '@opengraphity/types'
import { applyAuthorizationPolicy, authorize, permits, requirementOf } from '../authorization.js'
import { AUTHENTICATED, OPERATION_PERMISSIONS } from '../operationPermissions.js'
import { ForbiddenError } from '../errors.js'

type Resolver = (parent: unknown, args: unknown, ctx: never, info: never) => unknown

/** Every field the policy names, each answering with its own name. */
function fullResolverMap(): { Query: Record<string, Resolver | undefined>; Mutation: Record<string, Resolver | undefined> } {
  const Query: Record<string, Resolver | undefined> = {}
  const Mutation: Record<string, Resolver | undefined> = {}
  for (const op of OPERATION_PERMISSIONS.keys()) {
    const [kind, field] = op.split('.') as ['Query' | 'Mutation', string]
    ;(kind === 'Query' ? Query : Mutation)[field] = () => op
  }
  return { Query, Mutation }
}

/** A mutation guarded by a concrete permission list (not just "authenticated"). */
function guardedMutation(): { field: string; permission: Permission } {
  for (const [op, req] of OPERATION_PERMISSIONS) {
    if (op.startsWith('Mutation.') && req !== AUTHENTICATED && req.length > 0) {
      return { field: op.slice('Mutation.'.length), permission: req[0]! }
    }
  }
  throw new Error('no guarded mutation in the policy')
}

describe('authorize', () => {
  it('a field without any rule is a product defect (plain Error naming the file), not a Forbidden', () => {
    let err: unknown
    try { authorize('Query', 'fieldNobodyDecided', 'admin', new Set()) } catch (e) { err = e }
    expect(err).toBeInstanceOf(Error)
    // Why: a ForbiddenError would be shown to the user as a permission problem.
    expect(err).not.toBeInstanceOf(ForbiddenError)
    expect((err as Error).message).toMatch(/Query\.fieldNobodyDecided has no permission rule \(lib\/operationPermissions\.ts\)/)
  })

  it('a missing permission is a ForbiddenError that lists what would have opened it', () => {
    const { field, permission } = guardedMutation()
    let err: unknown
    try { authorize('Mutation', field, 'viewer', new Set()) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ForbiddenError)
    expect((err as ForbiddenError).message).toContain(`Role 'viewer' cannot run Mutation.${field}`)
    expect((err as ForbiddenError).message).toContain(permission)
    expect((err as ForbiddenError).extensions['code']).toBe('FORBIDDEN')
    expect(() => authorize('Mutation', field, 'custom', new Set([permission]))).not.toThrow()
  })

  it('dynamic CI fields use the CMDB permissions: read for queries, write for mutations', () => {
    const dyn = new Set(['Query.servers', 'Mutation.createServer'])
    expect(requirementOf('Query', 'servers', dyn)).toEqual(['cmdb.read'])
    expect(requirementOf('Mutation', 'createServer', dyn)).toEqual(['cmdb.write'])
    // Not registered as dynamic → undecided, never implicitly open.
    expect(requirementOf('Query', 'servers')).toBeUndefined()
    expect(() => authorize('Mutation', 'createServer', 'viewer', new Set(['cmdb.read'] as Permission[]), dyn)).toThrow(ForbiddenError)
    expect(() => authorize('Mutation', 'createServer', 'editor', new Set(['cmdb.write'] as Permission[]), dyn)).not.toThrow()
  })

  it('AUTHENTICATED opens the operation even with no permission at all', () => {
    expect(permits(AUTHENTICATED, new Set())).toBe(true)
    expect(permits([], new Set(['cmdb.read'] as Permission[]))).toBe(false)
  })
})

describe('applyAuthorizationPolicy', () => {
  it('refuses BEFORE the resolver runs, and lets the call through with the right permission', async () => {
    const { field, permission } = guardedMutation()
    const map = fullResolverMap()
    const spy = vi.fn(() => 'done')
    map.Mutation[field] = spy
    const wrapped = applyAuthorizationPolicy(map)
    const call = wrapped.Mutation[field]!
    expect(() => call(null, {}, { role: 'viewer', permissions: new Set() } as never, {} as never)).toThrow(ForbiddenError)
    // Why: a resolver that ran before the refusal would already have written.
    expect(spy).not.toHaveBeenCalled()
    expect(call(null, { a: 1 }, { role: 'x', permissions: new Set([permission]) } as never, {} as never)).toBe('done')
    expect(spy).toHaveBeenCalledWith(null, { a: 1 }, expect.anything(), {})
  })

  it('keeps non-function entries as they are and does not drop other resolver groups', () => {
    const map = { ...fullResolverMap(), Incident: { id: () => 'x' } }
    const [firstQuery] = Object.keys(map.Query)
    map.Query[firstQuery!] = undefined
    const wrapped = applyAuthorizationPolicy(map)
    expect(wrapped.Query[firstQuery!]).toBeUndefined()
    expect(wrapped.Incident).toBe(map.Incident)
  })

  it('startup fails when the policy names a field that does not exist', () => {
    const map = fullResolverMap()
    const [victim] = Object.keys(map.Mutation)
    delete map.Mutation[victim!]
    expect(() => applyAuthorizationPolicy(map)).toThrow(new RegExp(`policy names fields that do not exist: Mutation\\.${victim}`))
  })

  it('startup fails when a field has no rule, unless it is a registered dynamic CI field', () => {
    const map = fullResolverMap()
    map.Query['servers'] = () => []
    expect(() => applyAuthorizationPolicy(map)).toThrow(/fields without a permission rule .*Query\.servers/)
    expect(() => applyAuthorizationPolicy(map, { dynamicCI: new Set(['Query.servers']) })).not.toThrow()
  })

  it('an empty resolver map is rejected: every policy row is then missing', () => {
    expect(() => applyAuthorizationPolicy({})).toThrow(/policy names fields that do not exist/)
  })
})
