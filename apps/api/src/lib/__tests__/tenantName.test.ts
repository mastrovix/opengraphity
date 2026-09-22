/**
 * The organization name, as written from the Organization page.
 *
 * Why these behaviours matter:
 *  - The name is printed on every e-mail and PDF the tenant sends. An empty
 *    or 5,000-character name must be refused with a translatable error before
 *    anything is written, not truncated silently.
 *  - A tenant that does not exist is a NOT_FOUND, never a quiet success: a
 *    write to a missing node would otherwise look like it worked.
 *  - After a rename the schema caches are invalidated, otherwise other
 *    replicas keep serving the old name.
 *  - The session is closed on every path, including failures; a leaked
 *    session exhausts the Neo4j pool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const session = { close: vi.fn(async () => {}) }
const neo = vi.hoisted(() => ({ getSession: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => neo)
const invalidateSchema = vi.hoisted(() => vi.fn())
vi.mock('../schemaInvalidator.js', () => ({ invalidateSchema }))

const { assertTenantName, tenantName, setTenantName, TENANT_NAME_MAX_LENGTH } = await import('../tenantName.js')

function codeOf(e: unknown): unknown {
  return (e as { extensions?: { code?: string } }).extensions?.code
}

beforeEach(() => {
  vi.clearAllMocks()
  neo.getSession.mockReturnValue(session)
})

describe('assertTenantName', () => {
  it('trims and accepts a name within the limit', () => {
    expect(assertTenantName('  Acme S.p.A.  ')).toBe('Acme S.p.A.')
    expect(assertTenantName('x'.repeat(TENANT_NAME_MAX_LENGTH))).toHaveLength(TENANT_NAME_MAX_LENGTH)
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'x'.repeat(TENANT_NAME_MAX_LENGTH + 1)],
    ['not a string', 42],
    ['null', null],
  ])('refuses %s with a translatable validation error', (_label, raw) => {
    try {
      assertTenantName(raw)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(codeOf(e)).toBe('BAD_USER_INPUT')
      expect((e as { extensions: { i18n: { key: string } } }).extensions.i18n.key).toBe('errors.tenant.name')
    }
  })
})

describe('tenantName', () => {
  it('reads the name of the tenant it was asked about', async () => {
    neo.runQueryOne.mockResolvedValue({ name: 'Acme' })
    expect(await tenantName('t1')).toBe('Acme')
    expect(neo.runQueryOne.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('falls back to the tenant id when the node has no name yet', async () => {
    // Tenants onboarded before the name existed: the page must still show something.
    neo.runQueryOne.mockResolvedValue({ name: null })
    expect(await tenantName('t1')).toBe('t1')
  })

  it('a missing tenant is NOT_FOUND and the session is still closed', async () => {
    neo.runQueryOne.mockResolvedValue(null)
    await expect(tenantName('ghost')).rejects.toSatisfy((e) => codeOf(e) === 'NOT_FOUND')
    expect(session.close).toHaveBeenCalledOnce()
  })
})

describe('setTenantName', () => {
  it('writes the trimmed name in a WRITE session and invalidates the schema caches', async () => {
    neo.runQueryOne.mockResolvedValue({ id: 't1' })
    expect(await setTenantName('t1', '  New Name ')).toBe('New Name')
    expect(neo.getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(neo.runQueryOne.mock.calls[0]![2]).toMatchObject({ tenantId: 't1', name: 'New Name' })
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('refuses an invalid name before opening a session', async () => {
    await expect(setTenantName('t1', '')).rejects.toSatisfy((e) => codeOf(e) === 'BAD_USER_INPUT')
    expect(neo.getSession).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('a missing tenant is NOT_FOUND and nothing is invalidated', async () => {
    neo.runQueryOne.mockResolvedValue(null)
    await expect(setTenantName('ghost', 'Name')).rejects.toSatisfy((e) => codeOf(e) === 'NOT_FOUND')
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledOnce()
  })
})
