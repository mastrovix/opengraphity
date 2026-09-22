/**
 * The Access tab of the organization (resolvers/login.ts): password rules and
 * corporate login providers, written to the tenant's Keycloak realm.
 *
 * The rules themselves live in lib/tenantLogin.ts; what this layer owns and
 * what breaks for a user if it regresses:
 *  - every call is scoped to the CALLER's tenant (ctx.tenantId), never to an
 *    id from the arguments — otherwise one admin could rewrite another
 *    organization's login;
 *  - the settings page is told when the realm carries password rules out of
 *    the supported range (A-19), instead of silently showing clamped values;
 *  - every change leaves an Audit Log entry, and that entry never carries a
 *    secret (the provider's client secret must not end up in the log).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

const audit = vi.fn(async () => {})
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }))

const passwordRules = vi.fn()
const loginProviders = vi.fn()
const loginProviderAddresses = vi.fn()
const passwordRulesOutOfRange = vi.fn()
const setPasswordRules = vi.fn()
const testLoginProvider = vi.fn()
const saveLoginProvider = vi.fn()
const deactivateLoginProvider = vi.fn()
const removeLoginProvider = vi.fn()
vi.mock('../../../lib/tenantLogin.js', () => ({
  passwordRules: (...a: unknown[]) => passwordRules(...a),
  loginProviders: (...a: unknown[]) => loginProviders(...a),
  loginProviderAddresses: (...a: unknown[]) => loginProviderAddresses(...a),
  passwordRulesOutOfRange: (...a: unknown[]) => passwordRulesOutOfRange(...a),
  setPasswordRules: (...a: unknown[]) => setPasswordRules(...a),
  testLoginProvider: (...a: unknown[]) => testLoginProvider(...a),
  saveLoginProvider: (...a: unknown[]) => saveLoginProvider(...a),
  deactivateLoginProvider: (...a: unknown[]) => deactivateLoginProvider(...a),
  removeLoginProvider: (...a: unknown[]) => removeLoginProvider(...a),
}))

const { loginResolvers } = await import('../login.js')
const { Query, Mutation } = loginResolvers

const ctx = { tenantId: 'tenant-a', userId: 'admin-1', userEmail: 'admin@a.test', role: 'admin' } as unknown as GraphQLContext

const provider = {
  kind: 'microsoft', enabled: true, displayName: 'Contoso', clientId: 'cid', tenant: 'contoso.onmicrosoft.com',
  hostedDomain: null, metadataUrl: null,
}

beforeEach(() => { vi.clearAllMocks() })

describe('Query.loginSettings', () => {
  it('reads rules and providers of the caller tenant and reports out-of-range rules', async () => {
    const rules = { minLength: 200 }
    passwordRules.mockResolvedValue(rules)
    loginProviders.mockResolvedValue([provider])
    loginProviderAddresses.mockReturnValue({ redirectUri: 'https://kc/realms/tenant-a/broker' })
    passwordRulesOutOfRange.mockReturnValue(['minLength'])

    const out = await Query.loginSettings(undefined, undefined, ctx)

    expect(passwordRules).toHaveBeenCalledWith('tenant-a')
    expect(loginProviders).toHaveBeenCalledWith('tenant-a')
    expect(loginProviderAddresses).toHaveBeenCalledWith('tenant-a')
    // A-19: the out-of-range check runs on the rules actually read from the realm.
    expect(passwordRulesOutOfRange).toHaveBeenCalledWith(rules)
    expect(out).toEqual({
      passwordRules: rules, providers: [provider],
      addresses: { redirectUri: 'https://kc/realms/tenant-a/broker' },
      passwordRulesOutOfRange: ['minLength'],
    })
  })
})

describe('Mutation.setPasswordRules', () => {
  it('writes to the caller tenant, returns the new rules and audits before/after', async () => {
    setPasswordRules.mockResolvedValue({ before: { minLength: 8 }, after: { minLength: 12 } })
    const out = await Mutation.setPasswordRules(undefined, { input: { minLength: 12 } }, ctx)
    expect(setPasswordRules).toHaveBeenCalledWith('tenant-a', { minLength: 12 })
    expect(out).toEqual({ minLength: 12 })
    expect(audit).toHaveBeenCalledWith(ctx, 'login.password_rules_changed', 'Tenant', 'tenant-a', { before: { minLength: 8 }, after: { minLength: 12 } })
  })

  it('a rejected write leaves no audit entry', async () => {
    setPasswordRules.mockRejectedValue(new Error('minLength out of range'))
    await expect(Mutation.setPasswordRules(undefined, { input: {} }, ctx)).rejects.toThrow('out of range')
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('Mutation.testLoginProvider', () => {
  it('tests against the caller tenant and returns the checks as they are', async () => {
    const result = { ok: false, checks: [{ key: 'discovery', ok: false }] }
    testLoginProvider.mockResolvedValue(result)
    const input = { kind: 'google', clientId: 'x', clientSecret: 's' }
    await expect(Mutation.testLoginProvider(undefined, { input } as never, ctx)).resolves.toBe(result)
    expect(testLoginProvider).toHaveBeenCalledWith('tenant-a', input)
  })
})

describe('Mutation.saveLoginProvider', () => {
  const input = { kind: 'microsoft', clientId: 'cid', clientSecret: 'TOP-SECRET', tenant: 'contoso.onmicrosoft.com' }

  it('saves on the caller tenant and audits the checks, never the client secret', async () => {
    saveLoginProvider.mockResolvedValue({ provider, test: { checks: [{ key: 'discovery', ok: true }, { key: 'token', ok: false }] } })
    await expect(Mutation.saveLoginProvider(undefined, { input, activate: true } as never, ctx)).resolves.toBe(provider)
    expect(saveLoginProvider).toHaveBeenCalledWith('tenant-a', input, true)
    expect(audit).toHaveBeenCalledWith(ctx, 'login.provider_saved', 'LoginProvider', 'microsoft', {
      activated: true, displayName: 'Contoso', clientId: 'cid', tenant: 'contoso.onmicrosoft.com',
      hostedDomain: null, metadataUrl: null, checks: ['discovery:ok', 'token:ko'],
    })
    expect(JSON.stringify(audit.mock.calls)).not.toContain('TOP-SECRET')
  })

  it('saving without a test run audits an empty list of checks', async () => {
    saveLoginProvider.mockResolvedValue({ provider: { ...provider, enabled: false }, test: null })
    await Mutation.saveLoginProvider(undefined, { input, activate: false } as never, ctx)
    expect(audit).toHaveBeenCalledWith(ctx, 'login.provider_saved', 'LoginProvider', 'microsoft', expect.objectContaining({ activated: false, checks: [] }))
  })
})

describe('Mutation.deactivateLoginProvider / removeLoginProvider', () => {
  it('deactivates on the caller tenant and audits the kind returned by the realm', async () => {
    deactivateLoginProvider.mockResolvedValue({ ...provider, enabled: false })
    await expect(Mutation.deactivateLoginProvider(undefined, { kind: 'microsoft' }, ctx)).resolves.toMatchObject({ enabled: false })
    expect(deactivateLoginProvider).toHaveBeenCalledWith('tenant-a', 'microsoft')
    expect(audit).toHaveBeenCalledWith(ctx, 'login.provider_deactivated', 'LoginProvider', 'microsoft')
  })

  it('removes on the caller tenant, returns true and audits', async () => {
    removeLoginProvider.mockResolvedValue(undefined)
    await expect(Mutation.removeLoginProvider(undefined, { kind: 'google' }, ctx)).resolves.toBe(true)
    expect(removeLoginProvider).toHaveBeenCalledWith('tenant-a', 'google')
    expect(audit).toHaveBeenCalledWith(ctx, 'login.provider_removed', 'LoginProvider', 'google')
  })

  it('a failed removal is not audited and propagates', async () => {
    removeLoginProvider.mockRejectedValue(new Error('not found'))
    await expect(Mutation.removeLoginProvider(undefined, { kind: 'google' }, ctx)).rejects.toThrow('not found')
    expect(audit).not.toHaveBeenCalled()
  })
})
