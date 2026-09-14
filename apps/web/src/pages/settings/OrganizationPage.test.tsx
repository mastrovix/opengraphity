/**
 * Revisione del 14 set 2026 · F7: il fuso del cliente si sceglie dalla pagina
 * Organizzazione, accanto alla lingua. Prima si scriveva solo con uno script.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { GET_TENANT_LANGUAGE_SETTINGS, GET_TENANT_TIMEZONE_SETTINGS, GET_TENANT_SERVICE_CALENDAR, GET_PORTAL_SEVERITY_OPTIONS } from '@/graphql/queries'
import { SET_TENANT_TIMEZONE, SET_TENANT_SERVICE_CALENDAR, SET_PORTAL_SEVERITY_OPTIONS } from '@/graphql/mutations'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
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

type Option = { value: string; labels: { language: string; label: string }[] }
const portalOptions = (options: Option[] | null): GqlMock => ({
  request: { query: GET_PORTAL_SEVERITY_OPTIONS },
  result: { data: { portalSeverityOptions: options === null ? null : options.map((o) => ({ __typename: 'PortalSeverityOption', value: o.value, labels: o.labels.map((l) => ({ __typename: 'LocalizedLabel', ...l })) })) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('OrganizationPage — fuso orario', () => {
  it('mostra il fuso del cliente e salva quello scelto', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_TENANT_TIMEZONE, variables: (v) => { seen.push(v); return true } },
      result: { data: { setTenantTimezone: { __typename: 'TenantTimezoneSettings', timezone: 'America/New_York', available: AVAILABLE } } },
    }
    const { user } = renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions(null), save] })

    const select = await screen.findByLabelText('Time zone')
    await waitFor(() => expect(select).toHaveValue('Europe/Rome'))
    await user.selectOptions(select, 'America/New_York')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Organization time zone updated'))
    expect(seen).toEqual([{ timezone: 'America/New_York' }])
  })

  it('nessun fuso configurato → lo dice, invece di mostrarne uno a caso', async () => {
    renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones(null), calendar(FACTORY), portalOptions(null)] })
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
    const { user } = renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions(null), save] })

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

/**
 * Verifica «Cosa resta cablato», ondata 1: il portale offriva low/medium/high
 * scritti nel codice. Qui l'amministratore sceglie quali severità del SUO
 * vocabolario offrire, e con che parole.
 */
describe('OrganizationPage — severità del portale', () => {
  const SEVERITY = [
    { value: 'low', label: 'Low', labels: [{ language: 'en', label: 'Low' }, { language: 'it', label: 'Bassa' }] },
    { value: 'medium', label: 'Medium', labels: [] },
    { value: 'high', label: 'High', labels: [] },
    { value: 'blocker', label: 'Blocker', labels: [{ language: 'it', label: 'Bloccante' }] },
  ]
  const withVocabulary = (ui: React.ReactElement) => (
    <DomainVocabularyContext.Provider value={{
      valuesOf:  (n) => (n === 'severity' ? SEVERITY.map((e) => e.value) : null),
      labelOf:   (n, v) => (n === 'severity' ? SEVERITY.find((e) => e.value === v)?.label ?? null : null),
      colorOf:   () => null,
      entriesOf: (n) => (n === 'severity' ? SEVERITY : null),
      loading: false, error: null,
    }}>{ui}</DomainVocabularyContext.Provider>
  )

  it('mostra la scelta salvata e salva i valori spuntati, nell\'ordine del Dizionario, con le parole scritte', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_PORTAL_SEVERITY_OPTIONS, variables: (v) => { seen.push(v); return true } },
      result: { data: { setPortalSeverityOptions: [] } },
    }
    const { user } = renderWithProviders(withVocabulary(<OrganizationPage />), {
      route: '/settings/organization',
      mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions([{ value: 'high', labels: [{ language: 'en', label: 'Urgent' }] }]), save],
    })

    const high = await screen.findByRole('checkbox', { name: 'Offer High in the portal' })
    await waitFor(() => expect(high).toBeChecked())
    expect(screen.getByRole('textbox', { name: 'Label of High in English' })).toHaveValue('Urgent')
    // Un campo lasciato vuoto suggerisce l'etichetta del Dizionario.
    expect(screen.getByRole('textbox', { name: 'Label of Blocker in Italian' })).toHaveAttribute('placeholder', 'Bloccante')

    await user.click(screen.getByRole('checkbox', { name: 'Offer Blocker in the portal' }))
    await user.type(screen.getByRole('textbox', { name: 'Label of Blocker in English' }), 'It stops my work')
    await user.click(screen.getByRole('button', { name: 'Save portal severities' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Portal severities updated'))
    expect(seen).toEqual([{ options: [
      { value: 'high', labels: [{ language: 'en', label: 'Urgent' }, { language: 'it', label: '' }] },
      { value: 'blocker', labels: [{ language: 'en', label: 'It stops my work' }, { language: 'it', label: '' }] },
    ] }])
  })

  it('nessuna scelta salvata → lo dice, e senza valori spuntati non si salva', async () => {
    renderWithProviders(withVocabulary(<OrganizationPage />), {
      route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions(null)],
    })
    expect(await screen.findByText(/No severity has been chosen for the portal/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save portal severities' })).toBeDisabled()
  })
})
