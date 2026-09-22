/**
 * ProfilePage beyond language and e-mail (see ProfilePage.test.tsx): the Slack
 * link, the failure paths and the account card. What breaks for a person if
 * these regress: a Slack id that cannot be linked or unlinked (Slack actions
 * on incidents stop working for them), a language that looks switched while
 * the server refused it, or an account card that stays blank on an error with
 * no way to retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { ProfilePage } from './ProfilePage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

function me(overrides: Record<string, unknown> = {}) {
  return {
    me: {
      id: 'u-1', name: 'Ann Lee', email: 'ann@example.com', role: 'operator', roleName: 'Operator',
      permissions: [], slackId: null, emailNotifications: null, language: null, teams: [],
      ...overrides,
    },
  }
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.risposte['GetTenantLanguageSettings'] = { tenantLanguageSettings: { defaultLanguage: null } }
})

describe('ProfilePage — account card', () => {
  it('shows who is signed in', () => {
    apolloFinto.risposte['GetMe'] = me()
    renderWithProviders(<ProfilePage />)
    expect(screen.getByText('Ann Lee')).toBeInTheDocument()
    expect(screen.getByText('ann@example.com')).toBeInTheDocument()
    // No graph user behind the identity (emailNotifications null): no e-mail card to toggle.
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('on a load error shows the error with a retry that refetches', async () => {
    apolloFinto.erroriQuery['GetMe'] = new Error('backend down')
    const { user } = renderWithProviders(<ProfilePage />)
    expect(screen.getByText(/backend down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('says there is no account information when there is no user', () => {
    apolloFinto.risposte['GetMe'] = { me: null }
    renderWithProviders(<ProfilePage />)
    expect(screen.getByText('No account information available')).toBeInTheDocument()
    // The organisation has no default language: the option says so rather than naming one.
    expect(screen.getByRole('option', { name: /not configured/i })).toBeInTheDocument()
  })
})

describe('ProfilePage — language save failure', () => {
  it('keeps the previous choice and shows the error when the server refuses', async () => {
    window.localStorage.removeItem('og.language.chosen')
    apolloFinto.risposte['GetMe'] = me()
    apolloFinto.esiti['SetMyLanguage'] = { error: new Error('language refused') }
    const { user } = renderWithProviders(<ProfilePage />)
    const select = screen.getByRole('combobox', { name: 'Language' })
    await user.selectOptions(select, 'it')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('language refused'))
    // Applied only after the server took it: a refused choice must not become personal.
    expect(window.localStorage.getItem('og.language.chosen')).toBeNull()
    expect(select).toHaveValue('organization')
  })
})

describe('ProfilePage — Slack', () => {
  it('links the trimmed Slack id, and Save is disabled while the box is blank', async () => {
    apolloFinto.risposte['GetMe'] = me()
    const { user } = renderWithProviders(<ProfilePage />)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    const input = screen.getByLabelText('Your Slack user ID')
    await user.type(input, '   ')
    expect(save).toBeDisabled()
    await user.type(input, 'U012345 ')
    await user.click(save)
    expect(apolloFinto.chiamata('LinkSlack')).toEqual({ slackId: 'U012345' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Slack account linked'))
    // The box is emptied after a successful link, and the profile is reloaded.
    expect(input).toHaveValue('')
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('shows the linked id and unlinks it', async () => {
    apolloFinto.risposte['GetMe'] = me({ slackId: 'U999' })
    const { user } = renderWithProviders(<ProfilePage />)
    expect(screen.getByText('U999')).toBeInTheDocument()
    expect(screen.queryByLabelText('Your Slack user ID')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Unlink' }))
    expect(apolloFinto.chiamate['UnlinkSlack']).toHaveLength(1)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Slack account unlinked'))
  })
})
