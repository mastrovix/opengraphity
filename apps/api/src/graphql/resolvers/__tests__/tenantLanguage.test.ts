/**
 * The tenant's default language, from the UI.
 *
 * Why these behaviours matter:
 *  - The query is read by EVERY client at boot, before the user chose a
 *    language: if it demanded a permission, a plain agent (or a portal user)
 *    would get an error instead of a UI in the company's language.
 *  - The mutation changes what the whole company reads: only a role with
 *    `config.organization` may do it, and a refusal must happen BEFORE the
 *    value is written.
 *  - The default language is the fallback for vocabulary labels, which travel
 *    inside the per-tenant GraphQL schema: without invalidating it the
 *    Dictionary would keep speaking the old language until the cache expires.
 *  - The change is audited with the normalised value that was saved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const tenantDefaultLanguage = vi.fn()
const setTenantDefaultLanguage = vi.fn()
vi.mock('../../../lib/tenantLanguage.js', () => ({
  tenantDefaultLanguage: (...a: unknown[]) => tenantDefaultLanguage(...a),
  setTenantDefaultLanguage: (...a: unknown[]) => setTenantDefaultLanguage(...a),
  LINGUA_DI_ULTIMA_ISTANZA: 'en',
}))
const invalidateSchema = vi.fn()
vi.mock('../../../lib/schemaInvalidator.js', () => ({ invalidateSchema: (...a: unknown[]) => invalidateSchema(...a) }))
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { tenantLanguageResolvers } = await import('../tenantLanguage.js')

const ctx = (...permissions: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'agent', permissions: new Set(permissions),
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  tenantDefaultLanguage.mockResolvedValue('it')
  setTenantDefaultLanguage.mockImplementation(async (_t: string, l: string) => l)
})

describe('tenantLanguageSettings', () => {
  it('answers any role, scoped to the caller tenant, with the available languages and the fallback', async () => {
    const out = await tenantLanguageResolvers.Query.tenantLanguageSettings(null, null, ctx())
    expect(out).toEqual({ available: ['en', 'it'], defaultLanguage: 'it', fallback: 'en' })
    expect(tenantDefaultLanguage).toHaveBeenCalledWith('t1')
  })

  it('reports a tenant that never chose a language as null, so the client uses the fallback', async () => {
    tenantDefaultLanguage.mockResolvedValue(null)
    const out = await tenantLanguageResolvers.Query.tenantLanguageSettings(null, null, ctx())
    expect(out.defaultLanguage).toBeNull()
  })
})

describe('setTenantDefaultLanguage', () => {
  it('refuses a role without config.organization, and writes nothing', async () => {
    await expect(tenantLanguageResolvers.Mutation.setTenantDefaultLanguage(null, { language: 'en' }, ctx('workspace.use')))
      .rejects.toBeInstanceOf(GraphQLError)
    expect(setTenantDefaultLanguage).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('saves for the caller tenant, invalidates its schema, audits the saved value and returns the new settings', async () => {
    tenantDefaultLanguage.mockResolvedValue('en')
    const out = await tenantLanguageResolvers.Mutation.setTenantDefaultLanguage(null, { language: 'en' }, ctx('config.organization'))
    expect(setTenantDefaultLanguage).toHaveBeenCalledWith('t1', 'en')
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'tenant.default_language.updated', 'Tenant', 't1', { language: 'en' })
    // The answer is re-read after the write, so the client sees what is stored.
    expect(out.defaultLanguage).toBe('en')
  })

  it('an unknown language rejected by the store leaves the schema and the audit log untouched', async () => {
    setTenantDefaultLanguage.mockRejectedValue(new Error('Language "xx" not recognised'))
    await expect(tenantLanguageResolvers.Mutation.setTenantDefaultLanguage(null, { language: 'xx' }, ctx('config.organization')))
      .rejects.toThrow(/not recognised/)
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})
