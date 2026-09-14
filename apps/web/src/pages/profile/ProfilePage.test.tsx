/**
 * Revisione del 14 set 2026 · CO-1: le e-mail di collaborazione erano filtrate
 * su domini cablati. Ora la persona sceglie dal Profilo se riceverle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { SET_MY_EMAIL_NOTIFICATIONS } from '@/graphql/mutations'
import { GET_TENANT_LANGUAGE_SETTINGS } from '@/graphql/queries'
import i18n from '@/i18n/i18n'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { ProfilePage } from './ProfilePage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

beforeEach(() => { vi.mocked(toast.success).mockClear() })

describe('ProfilePage — e-mail di notifica', () => {
  it('mostra la scelta e la salva', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_MY_EMAIL_NOTIFICATIONS, variables: (v) => { seen.push(v); return true } },
      result: { data: { setMyEmailNotifications: { __typename: 'User', id: 'u-1', emailNotifications: false } } },
    }
    const { user } = renderWithProviders(<ProfilePage />, { route: '/profile', mocks: [meMock('operator', { maxUsageCount: Number.POSITIVE_INFINITY }), save] })
    const toggle = await screen.findByRole('switch', { name: 'Receive notifications by e-mail' })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    await user.click(toggle)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('E-mail notifications turned off'))
    expect(seen).toEqual([{ enabled: false }])
  })
})

/** Giro nel browser del 14 set 2026 (#61): dal Profilo non si tornava alla lingua dell'organizzazione. */
describe('ProfilePage — lingua', () => {
  const lang: GqlMock = {
    request: { query: GET_TENANT_LANGUAGE_SETTINGS },
    result: { data: { tenantLanguageSettings: { __typename: 'TenantLanguageSettings', available: ['en', 'it'], defaultLanguage: 'en', fallback: 'en' } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }

  it('scegliere una lingua la rende personale; «lingua dell\'organizzazione» dimentica la scelta', async () => {
    window.localStorage.removeItem('og.language.chosen')
    const { user } = renderWithProviders(<ProfilePage />, { route: '/profile', mocks: [meMock('operator', { maxUsageCount: Number.POSITIVE_INFINITY }), lang] })
    const select = await screen.findByRole('combobox', { name: 'Language' })
    await waitFor(() => expect(screen.getByRole('option', { name: "Organization's language (English)" })).toBeInTheDocument())
    expect(select).toHaveValue('organization')
    await user.selectOptions(select, 'it')
    await waitFor(() => expect(window.localStorage.getItem('og.language.chosen')).toBe('true'))
    await user.selectOptions(screen.getByRole('combobox'), 'organization')
    await waitFor(() => expect(window.localStorage.getItem('og.language.chosen')).toBeNull())
    await waitFor(() => expect(i18n.language).toBe('en'))
  })
})

