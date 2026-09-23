/**
 * Login & passwords: the paths the first test file does not walk.
 *
 * This page writes straight into the organisation's Keycloak realm, so a
 * regression here locks people out or silently weakens sign-in:
 *  - a value the realm carries OUTSIDE the product's range is named, instead
 *    of making every save fail with no explanation (A-19);
 *  - an invalid draft is explained and cannot be saved;
 *  - the lockout fields exist only while the lockout is on;
 *  - a provider's test shows each check with its detail, so the admin knows
 *    WHICH part of the Microsoft/Google/SAML setup is wrong;
 *  - turning a provider off and removing it are separate, and removal asks
 *    first (cancelling removes nothing);
 *  - each provider kind sends only its own fields (a Google hosted domain
 *    never reaches a SAML provider);
 *  - the return address can be copied as-is to register the app;
 *  - a load failure offers a retry instead of an empty page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { apolloFinto } from '@/test/apolloFinto'
import { renderWithProviders } from '@/test/utils'
import { LoginSecurityPage, type PasswordRules } from './LoginSecurityPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const RULES: PasswordRules = {
  minLength: 8, uppercase: 1, lowercase: 0, digits: 1, special: 0, notUsername: true, notEmail: false,
  history: 0, expireDays: 0, lockoutEnabled: false, lockoutFailures: 30, lockoutMinutes: 15,
}

const ADDRESSES = ['microsoft', 'google', 'saml'].map((kind) => ({
  kind,
  redirectUris: [`https://sso/realms/c-test/broker/${kind}/endpoint`],
  samlSpMetadataUrls: kind === 'saml' ? ['https://sso/realms/c-test/broker/saml/endpoint/descriptor'] : [],
}))

/**
 * Two ways to reach the sign-in page (D71, tour of 23 Sep 2026): the local one
 * and the Tailscale host. Each gets its own return address and SAML metadata.
 */
const ORIGINS = ['http://localhost:8080', 'https://mac.tail0.ts.net']
const TWO_ORIGINS = ['microsoft', 'google', 'saml'].map((kind) => {
  const redirectUris = ORIGINS.map((o) => `${o}/realms/c-test/broker/${kind}/endpoint`)
  const samlSpMetadataUrls = kind === 'saml' ? redirectUris.map((u) => `${u}/descriptor`) : []
  return { kind, redirectUris, samlSpMetadataUrls }
})

const MICROSOFT_ON = {
  kind: 'microsoft', displayName: 'Contoso login', enabled: true, clientId: 'app-1', tenant: 'contoso',
  hostedDomain: null, metadataUrl: null, redirectUri: 'https://sso/x', samlSpMetadataUrl: null,
}

function settings(extra: { providers?: unknown[]; outOfRange?: unknown[]; rules?: Partial<PasswordRules>; addresses?: unknown[] } = {}) {
  apolloFinto.risposte['GetLoginSettings'] = {
    loginSettings: {
      passwordRules: { __typename: 'PasswordRules', ...RULES, ...extra.rules },
      passwordRulesOutOfRange: extra.outOfRange ?? [],
      providers: extra.providers ?? [],
      addresses: extra.addresses ?? ADDRESSES,
    },
  }
}

/** The card of one provider kind, found by its heading. */
function card(heading: string): HTMLElement {
  return screen.getByText(heading).closest('div')!.parentElement!
}

/** The Save button of the password rules (the first "Save" on the page). */
const rulesSave = () => screen.getAllByRole('button', { name: 'Save' })[0]!

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('LoginSecurityPage — loading', () => {
  it('a load failure shows the error with a working retry', async () => {
    apolloFinto.erroriQuery['GetLoginSettings'] = new Error('realm unreachable')
    const { user } = renderWithProviders(<LoginSecurityPage />)
    expect(screen.getByText('realm unreachable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    // No provider cards without data: nothing to configure against.
    expect(screen.queryByText('Microsoft (Entra ID)')).toBeNull()
  })
})

describe('LoginSecurityPage — password rules', () => {
  it('a realm value outside the managed range is named with its range', () => {
    settings({ outOfRange: [{ rule: 'history', value: 50, min: 0, max: 24 }] })
    renderWithProviders(<LoginSecurityPage />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Keycloak has «Previous passwords that cannot be reused» at 50, outside the range this page manages (0–24).',
    )
  })

  it('an invalid draft is explained and cannot be saved', async () => {
    settings()
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const upper = screen.getByLabelText('Uppercase letters')
    await user.clear(upper)
    await user.type(upper, '9')
    // 9 uppercase + 1 digit do not fit in 8 characters.
    expect(screen.getByRole('alert')).toHaveTextContent('The required characters do not fit in the minimum length.')
    expect(rulesSave()).toBeDisabled()

    const history = screen.getByLabelText('Previous passwords that cannot be reused')
    await user.clear(history)
    // An emptied number is "no value", not zero: it shows empty and blocks the save.
    expect(history).toHaveValue(null)
    expect(screen.getByRole('alert')).toHaveTextContent('A value is outside its allowed range.')
    expect(rulesSave()).toBeDisabled()
  })

  it('switches and lifecycle fields go into the saved rules; lockout fields appear only when on', async () => {
    settings()
    const { user } = renderWithProviders(<LoginSecurityPage />)
    expect(screen.queryByLabelText('Wrong attempts before the block')).toBeNull()
    await user.click(screen.getByRole('switch', { name: 'Block temporarily after too many wrong attempts' }))
    const failures = screen.getByLabelText('Wrong attempts before the block')
    await user.clear(failures)
    await user.type(failures, '5')
    const minutes = screen.getByLabelText('Longest block (minutes)')
    await user.clear(minutes)
    await user.type(minutes, '30')
    await user.click(screen.getByRole('switch', { name: 'Different from the username' }))
    await user.click(screen.getByRole('switch', { name: 'Different from the e-mail address' }))
    for (const [label, value] of [['Lowercase letters', '1'], ['Symbols', '1'], ['Digits', '2'], ['Previous passwords that cannot be reused', '3'], ['Change the password every (days)', '90']] as const) {
      const input = screen.getByLabelText(label)
      await user.clear(input)
      await user.type(input, value)
    }
    await user.click(rulesSave())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Password rules saved'))
    expect(apolloFinto.chiamata('SetPasswordRules')).toEqual({ input: {
      ...RULES, lowercase: 1, special: 1, digits: 2, history: 3, expireDays: 90,
      notUsername: false, notEmail: true, lockoutEnabled: true, lockoutFailures: 5, lockoutMinutes: 30,
    } })
  })

  it('a refused save is reported', async () => {
    settings()
    apolloFinto.esiti['SetPasswordRules'] = { error: new Error('realm refused') }
    const { user } = renderWithProviders(<LoginSecurityPage />)
    await user.click(screen.getByRole('switch', { name: 'Different from the e-mail address' }))
    await user.click(rulesSave())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('realm refused'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('LoginSecurityPage — providers', () => {
  it('a configured provider: active pill, kept-secret hint, its saved fields prefilled', () => {
    settings({ providers: [MICROSOFT_ON] })
    renderWithProviders(<LoginSecurityPage />)
    const ms = card('Microsoft (Entra ID)')
    expect(within(ms).getByText('Active')).toBeInTheDocument()
    expect(within(ms).getByText(/The saved secret is never shown/)).toBeInTheDocument()
    expect(within(ms).getByLabelText('Tenant (id or domain)')).toHaveValue('contoso')
    expect(within(ms).getByLabelText('Client secret')).toHaveValue('')
    expect(within(card('Google Workspace')).getByText('Not configured')).toBeInTheDocument()
  })

  it('a saved but disabled provider shows "Off" and offers no "Turn off"', () => {
    settings({ providers: [{ ...MICROSOFT_ON, enabled: false }] })
    renderWithProviders(<LoginSecurityPage />)
    const ms = card('Microsoft (Entra ID)')
    expect(within(ms).getByText('Off')).toBeInTheDocument()
    expect(within(ms).queryByRole('button', { name: 'Turn off' })).toBeNull()
    expect(within(ms).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('test: every check is listed with its detail; a failing test is reported', async () => {
    settings({ providers: [MICROSOFT_ON] })
    apolloFinto.esiti['TestLoginProvider'] = { data: { testLoginProvider: { ok: false, checks: [
      { key: 'microsoftTenant', ok: true, detail: null },
      { key: 'microsoftCredentials', ok: false, detail: 'AADSTS7000215: invalid client secret' },
    ] } } }
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const ms = card('Microsoft (Entra ID)')
    await user.type(within(ms).getByLabelText('Client secret'), 'wrong')
    await user.click(within(ms).getByRole('button', { name: 'Test' }))
    const list = await within(ms).findByRole('list', { name: 'Test result' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Microsoft recognizes the tenant',
      'Microsoft accepts the application id and secret — AADSTS7000215: invalid client secret',
    ])
    expect(apolloFinto.chiamata('TestLoginProvider')).toEqual({ input: {
      kind: 'microsoft', displayName: 'Contoso login', clientId: 'app-1', clientSecret: 'wrong',
      tenant: 'contoso', hostedDomain: null, metadataUrl: null,
    } })

    apolloFinto.esiti['TestLoginProvider'] = { error: new Error('network down') }
    await user.click(within(ms).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'))
  })

  it('turn off, and a failed turn-off, are both reported', async () => {
    settings({ providers: [MICROSOFT_ON] })
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const ms = card('Microsoft (Entra ID)')
    await user.click(within(ms).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Provider turned off'))
    expect(apolloFinto.chiamata('DeactivateLoginProvider')).toEqual({ kind: 'microsoft' })

    apolloFinto.esiti['DeactivateLoginProvider'] = { error: new Error('cannot') }
    await user.click(within(ms).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('cannot'))
  })

  it('delete asks first: cancel removes nothing, confirm removes it', async () => {
    settings({ providers: [MICROSOFT_ON] })
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const ms = card('Microsoft (Entra ID)')
    await user.click(within(ms).getByRole('button', { name: 'Delete' }))
    let dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove sign-in with «Contoso login»?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamata('RemoveLoginProvider')).toBeUndefined()

    await user.click(within(ms).getByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Provider removed'))
    expect(apolloFinto.chiamata('RemoveLoginProvider')).toEqual({ kind: 'microsoft' })
  })

  it('a failed removal is reported', async () => {
    settings({ providers: [MICROSOFT_ON] })
    apolloFinto.esiti['RemoveLoginProvider'] = { error: new Error('still in use') }
    const { user } = renderWithProviders(<LoginSecurityPage />)
    await user.click(within(card('Microsoft (Entra ID)')).getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('still in use'))
  })

  it('Google sends its hosted domain and no tenant; a refused activation is reported', async () => {
    settings()
    apolloFinto.esiti['SaveLoginProvider'] = { error: new Error('bad client id') }
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const google = card('Google Workspace')
    expect(within(google).queryByLabelText('Tenant (id or domain)')).toBeNull()
    await user.type(within(google).getByLabelText('Client / application id'), 'g-1.apps.googleusercontent.com')
    await user.type(within(google).getByLabelText('Client secret'), 'gs')
    await user.type(within(google).getByLabelText('Allowed domain (optional)'), 'acme.com')
    await user.click(within(google).getByRole('button', { name: 'Test and activate' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('bad client id'))
    expect(apolloFinto.chiamata('SaveLoginProvider')).toEqual({ activate: true, input: {
      kind: 'google', displayName: null, clientId: 'g-1.apps.googleusercontent.com', clientSecret: 'gs',
      tenant: null, hostedDomain: 'acme.com', metadataUrl: null,
    } })
  })

  it('SAML needs only the metadata address, and never sends client credentials', async () => {
    settings()
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const saml = card('SAML')
    expect(within(saml).queryByLabelText('Client secret')).toBeNull()
    const activate = within(saml).getByRole('button', { name: 'Test and activate' })
    expect(activate).toBeDisabled()
    await user.type(within(saml).getByLabelText('Name on the sign-in page'), 'Corporate SSO')
    await user.type(within(saml).getByLabelText('Metadata address of the provider'), 'https://idp.acme.com/metadata')
    await user.click(activate)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Provider tested and activated'))
    expect(apolloFinto.chiamata('SaveLoginProvider')).toEqual({ activate: true, input: {
      kind: 'saml', displayName: 'Corporate SSO', clientId: null, clientSecret: null,
      tenant: null, hostedDomain: null, metadataUrl: 'https://idp.acme.com/metadata',
    } })
  })

  it('the SAML metadata address for the provider is copied exactly', async () => {
    settings()
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const saml = card('SAML')
    const field = within(saml).getByText('OpenGrafo metadata for the provider').parentElement!
    await user.click(within(field).getByRole('button', { name: 'Copy' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('https://sso/realms/c-test/broker/saml/endpoint/descriptor')
    expect(toast.success).toHaveBeenCalledWith('Copied!')
  })
})

describe('LoginSecurityPage — every address to register (D71, tour of 23 Sep 2026)', () => {
  const EVERY = 'Register every address: one for each address people use to reach the sign-in page'

  it('one return address per origin, each with its own «Copy», and one line saying to register them all', async () => {
    settings({ addresses: TWO_ORIGINS })
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const microsoft = card('Microsoft (Entra ID)')
    expect(within(microsoft).getByText(EVERY)).toBeInTheDocument()
    const field = within(microsoft).getByText('Return address to register with the provider').parentElement!
    expect(within(field).getByText('http://localhost:8080/realms/c-test/broker/microsoft/endpoint')).toBeInTheDocument()
    const copies = within(field).getAllByRole('button', { name: 'Copy' })
    expect(copies).toHaveLength(2)
    // Each button says WHICH address it copies.
    expect(copies[1]).toHaveAccessibleDescription('https://mac.tail0.ts.net/realms/c-test/broker/microsoft/endpoint')
    await user.click(copies[1]!)
    await expect(navigator.clipboard.readText()).resolves.toBe('https://mac.tail0.ts.net/realms/c-test/broker/microsoft/endpoint')
  })

  it('SAML: the metadata of OpenGrafo for every origin too', async () => {
    settings({ addresses: TWO_ORIGINS })
    const { user } = renderWithProviders(<LoginSecurityPage />)
    const field = within(card('SAML')).getByText('OpenGrafo metadata for the provider').parentElement!
    const copies = within(field).getAllByRole('button', { name: 'Copy' })
    expect(copies).toHaveLength(2)
    await user.click(copies[1]!)
    await expect(navigator.clipboard.readText()).resolves.toBe('https://mac.tail0.ts.net/realms/c-test/broker/saml/endpoint/descriptor')
  })

  it('a single origin: one address, and no line about registering several', () => {
    settings()
    renderWithProviders(<LoginSecurityPage />)
    expect(screen.queryByText(EVERY)).not.toBeInTheDocument()
    const field = within(card('Google Workspace')).getByText('Return address to register with the provider').parentElement!
    expect(within(field).getAllByRole('button', { name: 'Copy' })).toHaveLength(1)
    // No SAML metadata outside the SAML card.
    expect(within(card('Google Workspace')).queryByText('OpenGrafo metadata for the provider')).not.toBeInTheDocument()
  })
})
