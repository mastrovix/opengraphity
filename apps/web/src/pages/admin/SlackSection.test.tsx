/**
 * Ondata 8 di «Nulla cablato»: Slack dell'organizzazione nella pagina Integrazioni.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { SlackSection } from './SlackSection'
import { GET_SLACK_SETTINGS } from '@/graphql/queries'
import { CONNECT_SLACK_WITH_TOKEN } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const settings = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_SLACK_SETTINGS },
  result: { data: { slackSettings: { __typename: 'SlackSettings', installation: null, appInstallAvailable: false, secretsConfigured: true, requestUrls: null, ...over } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('SlackSection', () => {
  it('senza app della piattaforma e senza indirizzo pubblico: lo dice, e offre il collegamento con il token', async () => {
    const seen: unknown[] = []
    const connect: GqlMock = {
      request: { query: CONNECT_SLACK_WITH_TOKEN, variables: (v: unknown) => { seen.push(v); return true } },
      result: { data: { connectSlackWithToken: { __typename: 'SlackInstallation', mode: 'token', teamId: 'T1', teamName: 'Acme', installedAt: '2026-09-15T10:00:00Z', installedByName: 'admin' } } },
    }
    const { user } = renderWithProviders(<SlackSection />, { mocks: [settings(), connect, settings()] })
    expect(await screen.findByText(/Slack cannot reach OpenGrafo yet/)).toBeInTheDocument()
    expect(screen.getByText(/The OpenGrafo Slack app is not configured/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to Slack' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Bot token'), 'xoxb-1')
    await user.type(screen.getByLabelText('Signing secret'), '0123456789abcdef0123456789abcdef')
    await user.click(screen.getByRole('button', { name: 'Test and connect' }))
    await waitFor(() => expect(seen).toEqual([{ botToken: 'xoxb-1', signingSecret: '0123456789abcdef0123456789abcdef' }]))
  })

  it('collegato: mostra il workspace e il modo, mai un segreto; gli indirizzi da dare a Slack', async () => {
    renderWithProviders(<SlackSection />, {
      mocks: [settings({
        installation: { __typename: 'SlackInstallation', mode: 'app', teamId: 'T1', teamName: 'Acme Corp', installedAt: '2026-09-15T10:00:00Z', installedByName: 'admin@acme.com' },
        appInstallAvailable: true,
        requestUrls: { __typename: 'SlackRequestUrls', commands: 'https://og/api/slack/commands', actions: 'https://og/api/slack/actions', oauthCallback: 'https://og/api/slack/oauth/callback' },
      })],
    })
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText(/OpenGrafo app/)).toBeInTheDocument()
    expect(screen.getByText('https://og/api/slack/commands')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Bot token')).not.toBeInTheDocument()
  })
})
