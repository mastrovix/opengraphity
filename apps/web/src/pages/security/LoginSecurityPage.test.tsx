/**
 * Ondata 8 di «Nulla cablato»: la pagina Accesso e password.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { LoginSecurityPage, rulesProblem, type PasswordRules } from './LoginSecurityPage'
import { GET_LOGIN_SETTINGS } from '@/graphql/queries'
import { SAVE_LOGIN_PROVIDER, SET_PASSWORD_RULES } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const RULES: PasswordRules = { minLength: 8, uppercase: 1, lowercase: 0, digits: 1, special: 0, notUsername: true, notEmail: false, history: 0, expireDays: 0, lockoutEnabled: false, lockoutFailures: 30, lockoutMinutes: 15 }
const settings = (providers: unknown[] = []): GqlMock => ({
  request: { query: GET_LOGIN_SETTINGS },
  result: { data: { loginSettings: { __typename: 'LoginSettings', passwordRules: { __typename: 'PasswordRules', ...RULES }, providers, addresses: ['microsoft', 'google', 'saml'].map((kind) => ({ __typename: 'LoginProviderAddresses', kind, redirectUris: [`https://sso/realms/c-test/broker/${kind}/endpoint`], samlSpMetadataUrls: kind === 'saml' ? ['https://sso/realms/c-test/broker/saml/endpoint/descriptor'] : [] })) } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('rulesProblem', () => {
  it('fuori intervallo o caratteri obbligatori oltre la lunghezza minima', () => {
    expect(rulesProblem(RULES)).toBeNull()
    expect(rulesProblem({ ...RULES, minLength: 4 })).toBe('pages.loginSecurity.rules.outOfRange')
    expect(rulesProblem({ ...RULES, minLength: 6, uppercase: 3, digits: 4 })).toBe('pages.loginSecurity.rules.tooManyRequired')
  })
})

describe('LoginSecurityPage', () => {
  it('regole: salva solo dopo una modifica, con i valori scritti', async () => {
    const seen: unknown[] = []
    const save: GqlMock = { request: { query: SET_PASSWORD_RULES, variables: (v: unknown) => { seen.push(v); return true } }, result: { data: { setPasswordRules: { __typename: 'PasswordRules', ...RULES, minLength: 12 } } } }
    const { user } = renderWithProviders(<LoginSecurityPage />, { mocks: [settings(), save, settings()] })
    const len = await screen.findByLabelText('Minimum length')
    const saveBtn = screen.getAllByRole('button', { name: 'Save' })[0]!
    expect(saveBtn).toBeDisabled()
    await user.clear(len)
    await user.type(len, '12')
    await user.click(saveBtn)
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ input: { ...RULES, minLength: 12 } })
  })

  it('provider: tre schede; «Prova e attiva» manda i dati con activate=true e chiede il segreto', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SAVE_LOGIN_PROVIDER, variables: (v: unknown) => { seen.push(v); return true } },
      result: { data: { saveLoginProvider: { __typename: 'LoginProvider', kind: 'microsoft', displayName: 'Microsoft', enabled: true, clientId: 'app-1', tenant: 'acme', hostedDomain: null, metadataUrl: null, redirectUri: 'https://sso/x', samlSpMetadataUrl: null } } },
    }
    const { user } = renderWithProviders(<LoginSecurityPage />, { mocks: [settings(), save, settings()] })
    const card = (await screen.findByText('Microsoft (Entra ID)')).closest('div')!.parentElement!
    expect(screen.getByText('Google Workspace')).toBeInTheDocument()
    expect(screen.getByText('SAML')).toBeInTheDocument()
    // l'indirizzo di ritorno c'è prima di configurare: serve per registrare l'app presso Microsoft
    expect(within(card).getByText('https://sso/realms/c-test/broker/microsoft/endpoint')).toBeInTheDocument()
    const activate = within(card).getByRole('button', { name: 'Test and activate' })
    expect(activate).toBeDisabled()
    await user.type(within(card).getByLabelText('Tenant (id or domain)'), 'acme')
    await user.type(within(card).getByLabelText('Client / application id'), 'app-1')
    expect(activate).toBeDisabled()
    await user.type(within(card).getByLabelText('Client secret'), 's3cret')
    await user.click(activate)
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ activate: true, input: { kind: 'microsoft', displayName: null, clientId: 'app-1', clientSecret: 's3cret', tenant: 'acme', hostedDomain: null, metadataUrl: null } })
  })
})
