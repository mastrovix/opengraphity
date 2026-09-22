/**
 * Dictionary (enum type) resolvers: the refusals and races enumType.test.ts
 * does not reach.
 *
 * Why these behaviours matter: a dictionary is the list of values every ticket
 * and CI field offers. Its mutations are read-then-write, so between the two a
 * dictionary can disappear (another admin deleted it): the write must then say
 * "not found", not return a half-mapped object or crash on `records[0]`.
 * The other contracts pinned here:
 *  - `valueLabels(language)` refuses a language the product does not have
 *    instead of silently answering in another one;
 *  - the system tenant never customises shipped dictionaries (the product
 *    changes those);
 *  - deleting a customised copy whose own values are still in use (on records
 *    or in the alarm policy) is refused, naming where they are used, also when
 *    there is no shipped dictionary to fall back to;
 *  - `enumValueUsage` answers only for the tenant's own and shipped
 *    dictionaries, and "not used anywhere" is an explicit zero.
 * Usage counting itself is tested in lib/__tests__/enumValueUsage.test.ts;
 * here it is stubbed so each test controls exactly what is "in use".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { getSession: vi.fn(), toNumber: orig.toNumber, runQuery: vi.fn() }
})
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))
const countEnumValueUsage = vi.fn()
const replaceEnumValue = vi.fn()
vi.mock('../../../lib/enumValueUsage.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/enumValueUsage.js')>(),
  countEnumValueUsage: (...a: unknown[]) => countEnumValueUsage(...a),
  replaceEnumValue: (...a: unknown[]) => replaceEnumValue(...a),
}))

const { enumTypeResolvers, customizeEnumType, enumValueUsage } = await import('../enumType.js')
const { getSession } = await import('@opengraphity/neo4j')

const admin: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const systemAdmin: GraphQLContext = { ...admin, tenantId: 'system' }
const M = enumTypeResolvers.Mutation

const rec = (map: Record<string, unknown>) => ({ keys: Object.keys(map), get: (k: string) => (k in map ? map[k] : null) })

/** A session answering queries in order (read or write alike). */
function fakeSession(responses: Array<{ records: unknown[] }>) {
  const queue = [...responses]
  const txRun = vi.fn().mockImplementation(async () => queue.shift() ?? { records: [] })
  const tx = { run: txRun }
  const s = {
    txRun,
    executeRead:  vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

beforeEach(() => {
  vi.clearAllMocks()
  countEnumValueUsage.mockResolvedValue([])
  replaceEnumValue.mockResolvedValue(0)
})

describe('valueLabels(language)', () => {
  const parent = {
    id: 'e-1', values: ['low', 'high'],
    valueLabelsRaw: { low: { it: 'Bassa', en: 'Low' } },
  } as unknown as Parameters<typeof enumTypeResolvers.EnumTypeDefinition.valueLabels>[0]

  it('a language the product does not have is refused, naming the available ones', async () => {
    // Answering in English to a request for German would hide that German does not exist.
    await expectCode(
      enumTypeResolvers.EnumTypeDefinition.valueLabels(parent, { language: 'de' }, admin),
      'BAD_USER_INPUT', /Language "de" not recognised: the product has en, it/,
    )
  })

  it('a known language is honoured over the tenant default', async () => {
    const out = await enumTypeResolvers.EnumTypeDefinition.valueLabels(parent, { language: 'en' }, admin)
    expect(out[0]).toMatchObject({ value: 'low', label: 'Low' })
  })

  it('no language means the tenant default', async () => {
    const out = await enumTypeResolvers.EnumTypeDefinition.valueLabels(parent, { language: '' }, admin)
    expect(out[0]).toMatchObject({ value: 'low', label: 'Bassa' })
  })
})

describe('createEnumType', () => {
  it('a database error that is not the uniqueness constraint is propagated, not turned into "name exists"', async () => {
    // Masking a real outage as "that name is taken" would send the admin
    // looking for a duplicate that does not exist.
    const txRun = vi.fn().mockRejectedValue(new Error('ServiceUnavailable: connection lost'))
    const tx = { run: txRun }
    const close = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSession).mockReturnValue({
      executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
      close,
    } as never)
    await expect(M.createEnumType(null, { input: { name: 'ticket_source', label: 'X', values: ['a'], scope: 'itil' } }, admin))
      .rejects.toThrow('ServiceUnavailable: connection lost')
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('customizeEnumType', () => {
  it('the system tenant cannot customise shipped dictionaries, and no session is opened', async () => {
    await expectCode(customizeEnumType(null, { id: 'e-sys' }, systemAdmin), 'BAD_USER_INPUT', /system tenant does not customize/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('a CREATE that returns no node fails loudly instead of returning an empty dictionary', async () => {
    const s = fakeSession([
      { records: [rec({ tenantId: 'system', name: 'impact', label: 'Impact', values: ['low', 'high'], scope: 'itil' })] },
      { records: [] }, // no tenant copy with that name yet
      { records: [] }, // the CREATE
    ])
    await expect(customizeEnumType(null, { id: 'e-sys' }, admin)).rejects.toThrow(/customizeEnumType\("impact"\): the CREATE returned no node/)
    expect(s.close).toHaveBeenCalledOnce()
  })
})

describe('updateEnumType', () => {
  it('a dictionary deleted between the check and the write is NotFound', async () => {
    fakeSession([
      { records: [rec({ isSystem: false, tenantId: 'tenant-1', name: 'ticket_source', values: ['portal'] })] },
      { records: [] },
    ])
    await expectCode(M.updateEnumType(null, { id: 'e-1', input: { label: 'New' } }, admin), 'NOT_FOUND')
  })
})

describe('deleteEnumType — own values still in use', () => {
  const row = (shippedValues: unknown) => ({ records: [rec({
    isSystem: false, usageCount: 0, name: 'ci_status', values: ['active', 'dismesso'], shippedValues,
  })] })

  it('names the alarm-policy lists that cite a value, not only the records', async () => {
    const s = fakeSession([row(['active'])])
    countEnumValueUsage.mockResolvedValueOnce([
      { value: 'dismesso', records: [{ typeName: '__base__', fieldName: 'status', count: 3 }], policyLists: ['retired_statuses'], matrices: [], configSites: [], total: 4 },
    ])
    const err = await M.deleteEnumType(null, { id: 'e-1' }, admin).catch((e: unknown) => e) as GraphQLError
    expect(err.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err.message).toMatch(/"dismesso" \(3 __base__\.status, alarm policy: retired_statuses\)/)
    // Only the values the shipped dictionary lacks are counted: the others survive the delete.
    expect(countEnumValueUsage.mock.calls[0]![3]).toEqual(['dismesso'])
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('without a shipped dictionary to fall back to, the refusal says no value would be left', async () => {
    fakeSession([row(null)])
    countEnumValueUsage.mockResolvedValueOnce([
      { value: 'active', records: [], policyLists: ['maintenance_statuses'], matrices: [], configSites: [], total: 1 },
    ])
    const err = await M.deleteEnumType(null, { id: 'e-1' }, admin).catch((e: unknown) => e) as GraphQLError
    expect(err.message).toMatch(/which does not exist: no value would be left/)
    expect((err.extensions['i18n'] as { key: string }).key).toBe('errors.enum.deleteInUseNoShipped')
    // Every own value is "lost" when nothing is shipped under that name.
    expect(countEnumValueUsage.mock.calls[0]![3]).toEqual(['active', 'dismesso'])
  })

  it('values stored as a JSON string (older nodes) are still compared correctly', async () => {
    fakeSession([
      { records: [rec({ isSystem: false, usageCount: 0, name: 'ci_status', values: '["active"]', shippedValues: '["active"]' })] },
      { records: [] }, // the DELETE
    ])
    await expect(M.deleteEnumType(null, { id: 'e-1' }, admin)).resolves.toBe(true)
    expect(countEnumValueUsage).not.toHaveBeenCalled()
  })
})

describe('renameEnumValue', () => {
  const row = (over: Record<string, unknown> = {}) => ({ records: [rec({
    tenantId: 'tenant-1', name: 'ci_status', values: ['active', 'inactive'], defaultValue: null, ...over,
  })] })

  it('an empty (or blank) new value is refused before opening a session', async () => {
    await expectCode(M.renameEnumValue(null, { id: 'e-1', from: 'active', to: '   ' }, admin), 'BAD_USER_INPUT', /cannot be empty/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('a dictionary of another tenant is NotFound', async () => {
    const s = fakeSession([{ records: [] }])
    await expectCode(M.renameEnumValue(null, { id: 'other', from: 'a', to: 'b' }, admin), 'NOT_FOUND')
    expect(s.txRun.mock.calls[0]![1]).toEqual({ id: 'other', tenantId: 'tenant-1' })
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('renaming a value to itself is refused (after trimming), not a silent no-op rewrite of every record', async () => {
    fakeSession([row()])
    await expectCode(M.renameEnumValue(null, { id: 'e-1', from: 'active', to: ' active ' }, admin), 'BAD_USER_INPUT', /already called that/)
    expect(replaceEnumValue).not.toHaveBeenCalled()
  })

  it('a dictionary deleted during the rename is NotFound (records were rewritten in the same, rolled-back transaction)', async () => {
    fakeSession([row({ values: '["active","inactive"]' }), { records: [] }])
    await expectCode(M.renameEnumValue(null, { id: 'e-1', from: 'active', to: 'attivo' }, admin), 'NOT_FOUND')
    expect(replaceEnumValue).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'ci_status', 'active', 'attivo')
  })
})

describe('reorderEnumValues', () => {
  it('a dictionary of another tenant is NotFound', async () => {
    fakeSession([{ records: [] }])
    await expectCode(M.reorderEnumValues(null, { id: 'other', values: ['a'] }, admin), 'NOT_FOUND')
  })

  it('a shipped dictionary is reordered on the customer copy, not in place', async () => {
    const s = fakeSession([{ records: [rec({ tenantId: 'system', name: 'impact', values: ['low', 'high'] })] }])
    await expectCode(M.reorderEnumValues(null, { id: 'e-sys', values: ['high', 'low'] }, admin), 'BAD_USER_INPUT', /ships with the product.*Customize/s)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('values stored as a JSON string are accepted; a dictionary gone before the write is NotFound', async () => {
    fakeSession([{ records: [rec({ tenantId: 'tenant-1', name: 'impact', values: '["low","high"]' })] }, { records: [] }])
    await expectCode(M.reorderEnumValues(null, { id: 'e-1', values: ['high', 'low'] }, admin), 'NOT_FOUND')
  })

  it('a different set with only missing values names just those', async () => {
    fakeSession([{ records: [rec({ tenantId: 'tenant-1', name: 'impact', values: ['low', 'high'] })] }])
    const err = await M.reorderEnumValues(null, { id: 'e-1', values: ['low'] }, admin).catch((e: unknown) => e) as GraphQLError
    expect(err.message).toMatch(/missing: high/)
    expect(err.message).not.toMatch(/extra:/)
  })
})

describe('adoptShippedValues / acknowledgeShippedValues', () => {
  const COPY = { owner: 'tenant-1', name: 'priority', values: ['low'], seen: ['low'], shipped: ['low', 'critical'], valueLabels: null, valueColors: null, shippedLabels: null, shippedColors: null }

  it('an unknown or foreign dictionary is NotFound', async () => {
    fakeSession([{ records: [] }])
    await expectCode(M.adoptShippedValues(null, { id: 'other' }, admin), 'NOT_FOUND')
  })

  it('a corrupt value list is an error naming the dictionary, not a guess', async () => {
    fakeSession([{ records: [rec({ ...COPY, values: 'low,high' })] }])
    await expect(M.adoptShippedValues(null, { id: 'c-1' }, admin)).rejects.toThrow(/Dictionary "priority": values is not a list of strings/)
  })

  it('a corrupt "seen" list is also refused', async () => {
    fakeSession([{ records: [rec({ ...COPY, seen: [1, 2] })] }])
    await expect(M.acknowledgeShippedValues(null, { id: 'c-1' }, admin)).rejects.toThrow(/shipped_values_seen is not a list of strings/)
  })

  it('adopt: a copy deleted before the write is NotFound', async () => {
    fakeSession([{ records: [rec(COPY)] }, { records: [] }])
    await expectCode(M.adoptShippedValues(null, { id: 'c-1' }, admin), 'NOT_FOUND')
  })

  it('acknowledge: a copy deleted before the write is NotFound', async () => {
    fakeSession([{ records: [rec(COPY)] }, { records: [] }])
    await expectCode(M.acknowledgeShippedValues(null, { id: 'c-1' }, admin), 'NOT_FOUND')
  })
})

describe('enumValueUsage', () => {
  it('reads only the tenant\'s own or shipped dictionaries; a foreign id is NotFound', async () => {
    const s = fakeSession([{ records: [] }])
    await expectCode(enumValueUsage(null, { id: 'other', value: 'x' }, admin), 'NOT_FOUND')
    const [cypher, params] = s.txRun.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain("e.tenant_id = $tenantId OR (e.is_system = true AND e.tenant_id = 'system')")
    expect(params).toEqual({ id: 'other', tenantId: 'tenant-1' })
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('returns the usage of the value in this tenant, by dictionary name', async () => {
    fakeSession([{ records: [rec({ name: 'ci_status' })] }])
    const usage = { value: 'active', records: [{ typeName: '__base__', fieldName: 'status', count: 9 }], policyLists: [], matrices: [], configSites: [], total: 9 }
    countEnumValueUsage.mockResolvedValueOnce([usage])
    await expect(enumValueUsage(null, { id: 'e-1', value: 'active' }, admin)).resolves.toEqual(usage)
    expect(countEnumValueUsage.mock.calls[0]!.slice(1)).toEqual(['tenant-1', 'ci_status', ['active']])
  })

  it('a value used nowhere is an explicit zero, so the page can say "safe to rename"', async () => {
    fakeSession([{ records: [rec({ name: 'ci_status' })] }])
    await expect(enumValueUsage(null, { id: 'e-1', value: 'unused' }, admin)).resolves.toEqual({
      value: 'unused', records: [], policyLists: [], matrices: [], configSites: [], total: 0,
    })
  })
})
