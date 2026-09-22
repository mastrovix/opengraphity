/**
 * SLACK OF THE ORGANIZATION: the paths the first test file does not walk.
 *
 * Why they matter to an administrator:
 *  - coming back from Slack after «Add to Slack», the page must SAY how it
 *    went and clean the address: otherwise a reload repeats the toast, and a
 *    refused installation looks like nothing happened;
 *  - «Add to Slack» must send the administrator to Slack with a return
 *    address that brings them back to this tab;
 *  - disconnecting stops the bot for everyone, so it asks first, and a
 *    cancelled confirmation must change nothing;
 *  - a token that fails is reported and the typed secrets are kept, so the
 *    administrator can fix a typo instead of pasting both again;
 *  - without the encryption key the platform cannot store tokens: the page
 *    says so and does not offer a button that would fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { SlackSection } = await import('./SlackSection')

const URLS = { commands: 'https://og/api/slack/commands', actions: 'https://og/api/slack/actions', oauthCallback: 'https://og/cb' }

const settings = (over: Record<string, unknown> = {}) => {
  apolloFinto.risposte['GetSlackSettings'] = {
    slackSettings: { installation: null, appInstallAvailable: true, secretsConfigured: true, requestUrls: URLS, ...over },
  }
}

const installation = (over: Record<string, unknown> = {}) => ({
  mode: 'token', teamId: 'T1', teamName: 'Acme', installedAt: '2026-09-15T10:00:00Z', installedByName: null, ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
})

describe('SlackSection — coming back from Slack', () => {
  it('a successful installation is announced, the address is cleaned and the settings reloaded', async () => {
    settings()
    renderWithProviders(<SlackSection />, { route: '/admin/integrations?tab=slack&slack=connected' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Slack connected'))
    await attendiURL('/admin/integrations', { tab: 'slack' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a failed installation says why, and the reason is cleaned from the address too', async () => {
    settings()
    renderWithProviders(<SlackSection />, { route: '/admin/integrations?tab=slack&slack=failed&reason=access_denied' })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The Slack installation did not complete: access_denied'))
    await attendiURL('/admin/integrations', { tab: 'slack' })
  })

  it('a failure without a reason still says it failed', async () => {
    settings()
    renderWithProviders(<SlackSection />, { route: '/admin/integrations?slack=failed' })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The Slack installation did not complete: '))
    await attendiURL('/admin/integrations')
  })
})

describe('SlackSection — «Add to Slack»', () => {
  it('asks the server for the Slack address with a return address to this tab, then goes there', async () => {
    settings()
    // A hash-only address: jsdom can follow it, a real cross-site one it cannot.
    const target = `${window.location.origin}${window.location.pathname}#slack-oauth`
    apolloFinto.esiti['StartSlackInstall'] = { data: { startSlackInstall: target } }
    const { user } = renderWithProviders(<SlackSection />)
    await user.click(screen.getByRole('button', { name: 'Add to Slack' }))
    await waitFor(() => expect(window.location.hash).toBe('#slack-oauth'))
    expect(apolloFinto.chiamata('StartSlackInstall')).toEqual({
      returnTo: `${window.location.origin}${window.location.pathname}?tab=slack`,
    })
  })

  it('a server error is shown, and nobody is sent anywhere', async () => {
    settings()
    window.location.hash = ''
    apolloFinto.esiti['StartSlackInstall'] = { error: new Error('Slack app misconfigured') }
    const { user } = renderWithProviders(<SlackSection />)
    await user.click(screen.getByRole('button', { name: 'Add to Slack' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Slack app misconfigured'))
    expect(window.location.hash).toBe('')
  })

  it('an answer without data does not navigate', async () => {
    settings()
    window.location.hash = ''
    apolloFinto.esiti['StartSlackInstall'] = {}
    const { user } = renderWithProviders(<SlackSection />)
    await user.click(screen.getByRole('button', { name: 'Add to Slack' }))
    await waitFor(() => expect(apolloFinto.chiamata('StartSlackInstall')).toBeDefined())
    expect(window.location.hash).toBe('')
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('SlackSection — connecting with a token', () => {
  it('a working token connects, the secrets are cleared from the form and the success is announced', async () => {
    settings({ appInstallAvailable: false })
    const { user } = renderWithProviders(<SlackSection />)
    await user.type(screen.getByLabelText('Bot token'), 'xoxb-1')
    await user.type(screen.getByLabelText('Signing secret'), 'sig')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Slack connected'))
    expect(apolloFinto.chiamata('ConnectSlackWithToken')).toEqual({ botToken: 'xoxb-1', signingSecret: 'sig' })
    // Secrets must not linger in the page once stored.
    expect(screen.getByLabelText('Bot token')).toHaveValue('')
    expect(screen.getByLabelText('Signing secret')).toHaveValue('')
  })

  it('a refused token is reported and what was typed is kept', async () => {
    settings()
    apolloFinto.esiti['ConnectSlackWithToken'] = { error: new Error('invalid_auth') }
    const { user } = renderWithProviders(<SlackSection />)
    await user.type(screen.getByLabelText('Bot token'), 'xoxb-bad')
    await user.type(screen.getByLabelText('Signing secret'), 'sig')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('invalid_auth'))
    expect(screen.getByLabelText('Bot token')).toHaveValue('xoxb-bad')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('without the encryption key the page says so and the connect button stays off', async () => {
    settings({ secretsConfigured: false })
    const { user } = renderWithProviders(<SlackSection />)
    expect(screen.getByText(/SECRETS_ENCRYPTION_KEY is not set/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Bot token'), 'xoxb-1')
    await user.type(screen.getByLabelText('Signing secret'), 'sig')
    expect(screen.getByRole('button', { name: 'Test and connect' })).toBeDisabled()
  })
})

describe('SlackSection — connected workspace', () => {
  it('shows the token mode, and a dash when nobody is recorded as the installer', () => {
    settings({ installation: installation() })
    renderWithProviders(<SlackSection />)
    expect(screen.getByText(/Your organization's Slack app · connected by — on/)).toBeInTheDocument()
  })

  it('disconnecting asks first, naming the workspace; confirming disconnects', async () => {
    settings({ installation: installation() })
    const { user } = renderWithProviders(<SlackSection />)
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Disconnect the Slack workspace «Acme»?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Slack disconnected'))
    expect(apolloFinto.chiamate['DisconnectSlack']).toHaveLength(1)
  })

  it('a cancelled confirmation disconnects nothing', async () => {
    settings({ installation: installation() })
    const { user } = renderWithProviders(<SlackSection />)
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamate['DisconnectSlack']).toBeUndefined()
  })

  it('a failed disconnection is reported, not announced as done', async () => {
    settings({ installation: installation() })
    apolloFinto.esiti['DisconnectSlack'] = { error: new Error('not allowed') }
    const { user } = renderWithProviders(<SlackSection />)
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not allowed'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('SlackSection — the rest of the page', () => {
  it('the addresses for the Slack app can be copied', async () => {
    settings()
    const { user } = renderWithProviders(<SlackSection />)
    const copy = screen.getAllByRole('button', { name: 'Copy' })
    await user.click(copy[1]!)
    expect(await navigator.clipboard.readText()).toBe(URLS.actions)
    expect(toast.success).toHaveBeenCalledWith('Copied!')
  })

  it('a failed load shows the error with a retry that reloads', async () => {
    apolloFinto.erroriQuery['GetSlackSettings'] = new Error('network down')
    const { user } = renderWithProviders(<SlackSection />)
    expect(screen.getByText(/network down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
