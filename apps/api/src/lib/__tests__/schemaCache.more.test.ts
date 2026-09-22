/**
 * Per-tenant GraphQL schema cache — the safety nets the main suite does not
 * reach.
 *
 * Why these matter to a user:
 *  - an unreadable metamodel (corrupt JSON in the graph) must degrade to the
 *    base schema, not answer 500 to every GraphQL request: the admin needs
 *    the API, the diagnostics banner and the metamodel mutations to repair it;
 *  - when a SHIPPED type (not the customer's) is what breaks the assembly,
 *    the net must still serve something — otherwise every request of the
 *    tenant fails;
 *  - "invalidate every tenant" (after the pub/sub channel lost messages) must
 *    really rebuild each schema, including one whose build was in flight,
 *    or tenants keep a stale schema for the 5-minute TTL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

const loadMetamodel   = vi.fn()
const registerCITypes = vi.fn()

vi.mock('@opengraphity/schema-generator', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/schema-generator')>()
  return { ...orig, loadMetamodel }
})
vi.mock('../ciTypeFromLabels.js', () => ({ registerCITypes }))
vi.mock('../../graphql/resolvers/index.js', () => ({ buildResolvers: () => ({}) }))

const { getSchemaForTenant, getSchemaState } = await import('../schemaCache.js')
const { invalidateSchema, clearAllMetamodelCaches } = await import('../schemaInvalidator.js')

function ciType(name: string, scope: 'base' | 'tenant' = 'tenant'): CITypeWithDefinitions {
  const pascal = name.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return {
    id: `t-${name}`, name, label: name, icon: 'box', color: 'var(--color-brand)',
    scope, tenantId: scope === 'tenant' ? 'c-one' : 'system', active: true,
    neo4jLabel: pascal, validationScript: null, chainFamilies: [],
    fields: [{
      id: `f-${name}`, name: 'labelText', label: 'Label', fieldType: 'string',
      required: false, defaultValue: null, enumValues: [], order: 1,
      scope, tenantId: scope === 'tenant' ? 'c-one' : 'system',
      validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false,
    }],
    relations: [], systemRelations: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  loadMetamodel.mockImplementation(async () => [ciType('site')])
  clearAllMetamodelCaches()
})

describe('unreadable metamodel', () => {
  it('serves the base schema, degraded, with the loader message as the reason', async () => {
    loadMetamodel.mockRejectedValueOnce(new Error('chainFamilies is not valid JSON'))
    const state = await getSchemaState('t-corrupt')
    expect(state.degraded).toBe(true)
    expect(state.reason).toContain('chainFamilies is not valid JSON')
    // The product API is still there, so the admin can act.
    expect(state.schema.getType('Incident')).toBeDefined()
    expect(state.schema.getType('Site')).toBeUndefined()
    // The CI-type registry is told the tenant has no types, not left stale.
    expect(registerCITypes).toHaveBeenCalledWith('t-corrupt', [])
  })

  it('a non-Error rejection is still turned into a readable reason', async () => {
    loadMetamodel.mockRejectedValueOnce('boom')
    const state = await getSchemaState('t-corrupt-2')
    expect(state.reason).toContain('boom')
  })

  it('the degraded entry is cached like any other (no rebuild storm while broken)', async () => {
    loadMetamodel.mockRejectedValueOnce(new Error('bad'))
    const a = await getSchemaForTenant('t-corrupt-3')
    const b = await getSchemaForTenant('t-corrupt-3')
    expect(Object.is(a, b)).toBe(true)
    expect(loadMetamodel).toHaveBeenCalledTimes(1)
  })
})

describe('a shipped type breaks the assembly', () => {
  it('no customer type is to blame: the tenant still gets a degraded, queryable schema', async () => {
    // `2fa` is not a valid GraphQL name; as a SHIPPED (base) type no customer
    // type can be excluded to fix it.
    loadMetamodel.mockResolvedValueOnce([ciType('2fa', 'base')])
    const state = await getSchemaState('t-shipped')
    expect(state.degraded).toBe(true)
    expect(state.reason).toMatch(/2fa/)
    expect(state.schema.getType('Incident')).toBeDefined()
    // Before the fix this threw: every request of the tenant answered 500.
    expect(registerCITypes).toHaveBeenCalledWith('t-shipped', [])
  })

  it('with customer types too, they are not blamed and the API still answers', async () => {
    loadMetamodel.mockResolvedValueOnce([ciType('2fa', 'base'), ciType('site')])
    const state = await getSchemaState('t-shipped-2')
    expect(state.degraded).toBe(true)
    expect(state.schema.getQueryType()).toBeDefined()
    expect(state.schema.getType('Incident')).toBeDefined()
  })
})

describe('invalidating every tenant at once', () => {
  it('rebuilds the schema of each cached tenant on its next request', async () => {
    const one = await getSchemaForTenant('t-a')
    const two = await getSchemaForTenant('t-b')
    expect(loadMetamodel).toHaveBeenCalledTimes(2)

    const outcome = clearAllMetamodelCaches()
    expect(outcome.failed).toEqual([])

    expect(Object.is(await getSchemaForTenant('t-a'), one)).toBe(false)
    expect(Object.is(await getSchemaForTenant('t-b'), two)).toBe(false)
    expect(loadMetamodel).toHaveBeenCalledTimes(4)
  })

  it('a build in flight when everything is invalidated does not re-enter the cache', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    loadMetamodel.mockImplementationOnce(async () => { await gate; return [ciType('site')] })
    const building = getSchemaForTenant('t-flight')

    clearAllMetamodelCaches()
    release()
    const stale = await building
    loadMetamodel.mockImplementation(async () => [ciType('site'), ciType('cabinet')])
    const fresh = await getSchemaForTenant('t-flight')
    expect(Object.is(fresh, stale)).toBe(false)
    expect(fresh.getType('Cabinet')).toBeDefined()
  })

  it('a single-tenant invalidation of a tenant never cached is harmless', async () => {
    expect(() => invalidateSchema('never-seen')).not.toThrow()
  })
})
