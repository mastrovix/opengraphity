/**
 * Revisione del 14 set 2026 · F7: il fuso del cliente si sceglie dalla pagina
 * Organizzazione, accanto alla lingua. Prima si scriveva solo con uno script.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { GET_TENANT_LANGUAGE_SETTINGS, GET_TENANT_TIMEZONE_SETTINGS, GET_TENANT_SERVICE_CALENDAR } from '@/graphql/queries'
import { SET_TENANT_TIMEZONE, SET_TENANT_SERVICE_CALENDAR } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { OrganizationPage } from './OrganizationPage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const AVAILABLE = ['America/New_York', 'Europe/Rome', 'UTC']
const language: GqlMock = {
  request: { query: GET_TENANT_LANGUAGE_SETTINGS },
  result: { data: { tenantLanguageSettings: { __typename: 'TenantLanguageSettings', available: ['en', 'it'], defaultLanguage: 'en', fallback: 'en' } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const zones = (timezone: string | null): GqlMock => ({
  request: { query: GET_TENANT_TIMEZONE_SETTINGS },
  result: { data: { tenantTimezoneSettings: { __typename: 'TenantTimezoneSettings', timezone, available: AVAILABLE } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const calendar = (value: unknown): GqlMock => ({
  request: { query: GET_TENANT_SERVICE_CALENDAR },
  result: { data: { tenantServiceCalendar: value === null ? null : { __typename: 'ServiceCalendar', ...(value as object) } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})
const FACTORY = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', holidays: [] as string[] }

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('OrganizationPage — fuso orario', () => {
  it('mostra il fuso del cliente e salva quello scelto', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_TENANT_TIMEZONE, variables: (v) => { seen.push(v); return true } },
      result: { data: { setTenantTimezone: { __typename: 'TenantTimezoneSettings', timezone: 'America/New_York', available: AVAILABLE } } },
    }
    const { user } = renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), save] })

    const select = await screen.findByLabelText('Time zone')
    await waitFor(() => expect(select).toHaveValue('Europe/Rome'))
    await user.selectOptions(select, 'America/New_York')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Organization time zone updated'))
    expect(seen).toEqual([{ timezone: 'America/New_York' }])
  })

  it('nessun fuso configurato → lo dice, invece di mostrarne uno a caso', async () => {
    renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones(null), calendar(FACTORY)] })
    const select = await screen.findByLabelText('Time zone')
    await waitFor(() => expect(select).toHaveValue(''))
    expect(screen.getByText(/No time zone has been chosen/)).toBeInTheDocument()
  })
})

/**
 * Revisione del 14 set 2026 · F6: l'orario lavorativo delle policy SLA e dei
 * contratti OLA era 08–18, lunedì–venerdì, senza festività, per tutti. Ora si
 * sceglie qui.
 */
describe('OrganizationPage — calendario di servizio', () => {
  it('mostra il calendario, e salva giorni, fascia e festività', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_TENANT_SERVICE_CALENDAR, variables: (v) => { seen.push(v); return true } },
      result: (v) => ({ data: { setTenantServiceCalendar: { __typename: 'ServiceCalendar', ...(v as { calendar: object }).calendar } } }),
    }
    const { user } = renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), save] })

    const saturday = await screen.findByRole('checkbox', { name: 'Saturday' })
    expect(saturday).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Monday' })).toBeChecked()
    await user.click(saturday)
    await user.clear(screen.getByLabelText('Business hours end'))
    await user.type(screen.getByLabelText('Business hours end'), '17:00')
    await user.type(screen.getByLabelText('Holidays'), '2026-12-25, 2026-12-26')
    await user.click(screen.getByRole('button', { name: 'Save calendar' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Service calendar updated'))
    expect(seen).toEqual([{ calendar: { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00', holidays: ['2026-12-25', '2026-12-26'] } }])
  })

  it('senza calendario lo dice, e le caselle partono vuote', async () => {
    renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(null)] })
    expect(await screen.findByText(/No service calendar has been chosen/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Monday' })).not.toBeChecked()
  })
})
