/**
 * Revisione del 14 set 2026 · F7: il fuso del cliente si sceglie dalla pagina
 * Organizzazione, accanto alla lingua. Prima si scriveva solo con uno script.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { GET_TENANT_LANGUAGE_SETTINGS, GET_TENANT_TIMEZONE_SETTINGS, GET_SERVICE_CALENDARS, GET_PORTAL_SEVERITY_OPTIONS, GET_TENANT_INAPP_RETENTION } from '@/graphql/queries'
import { SET_TENANT_TIMEZONE, CREATE_SERVICE_CALENDAR, SET_PORTAL_SEVERITY_OPTIONS, SET_TENANT_INAPP_RETENTION } from '@/graphql/mutations'
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

type Calendar = { id: string; name: string; days: number[]; start: string; end: string; holidays: string[]; usedBySlaPolicies: string[]; usedByOlaContracts: string[]; usedByWorkflowSteps: string[] }
const calendar = (list: Calendar[]): GqlMock => ({
  request: { query: GET_SERVICE_CALENDARS },
  result: { data: { serviceCalendars: list.map((c) => ({ __typename: 'ServiceCalendar', ...c })) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})
const FACTORY: Calendar[] = [{ id: 'cal-1', name: 'Service hours', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', holidays: [], usedBySlaPolicies: ['Incident di rete'], usedByOlaContracts: [], usedByWorkflowSteps: [] }]

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
 * Revisione del 14 set 2026 · F6 e verifica «Cosa resta cablato», ondata 2:
 * l'orario lavorativo era 08–18 lun–ven per tutti, poi un calendario per
 * organizzazione; ora calendari con nome, scelti da policy e contratti.
 */
describe('OrganizationPage — calendari di servizio', () => {
  it('elenca i calendari con chi li usa; uno in uso non si può eliminare', async () => {
    renderWithProviders(<OrganizationPage />, { route: '/settings/organization?tab=service', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions(null)] })
    const row = (await screen.findByText('Service hours')).closest('li')!
    expect(row).toHaveTextContent('Mon Tue Wed Thu Fri · 08:00–18:00')
    expect(row).toHaveTextContent('Used by: Incident di rete')
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('crea un calendario con nome, giorni, fascia e festività', async () => {
    const seen: unknown[] = []
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_CALENDAR, variables: (v) => { seen.push(v); return true } },
      result: { data: { createServiceCalendar: { __typename: 'ServiceCalendar', id: 'cal-2', name: 'Turno NOC', days: [1, 2, 3, 4, 5, 6], start: '07:00', end: '22:00', holidays: ['2026-12-25'], usedBySlaPolicies: [], usedByOlaContracts: [], usedByWorkflowSteps: [] } } },
    }
    const { user } = renderWithProviders(<OrganizationPage />, { route: '/settings/organization?tab=service', mocks: [language, zones('Europe/Rome'), calendar([]), portalOptions(null), create] })

    expect(await screen.findByText(/No service calendar yet/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New calendar' }))
    const save = screen.getByRole('button', { name: 'Save calendar' })
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText('Name'), 'Turno NOC')
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) await user.click(screen.getByRole('checkbox', { name: day }))
    await user.type(screen.getByLabelText('Business hours start'), '07:00')
    await user.type(screen.getByLabelText('Business hours end'), '22:00')
    await user.type(screen.getByLabelText('Holidays'), '2026-12-25')
    await user.click(save)

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Service calendar created'))
    expect(seen).toEqual([{ name: 'Turno NOC', calendar: { days: [1, 2, 3, 4, 5, 6], start: '07:00', end: '22:00', holidays: ['2026-12-25'] } }])
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
      route: '/settings/organization?tab=portal',
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
      route: '/settings/organization?tab=portal', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions(null)],
    })
    expect(await screen.findByText(/No severity has been chosen for the portal/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save portal severities' })).toBeDisabled()
  })
})

/** Verifica «Cosa resta cablato», ondata 2: la conservazione delle notifiche era una variabile d'ambiente per tutti. */
describe('OrganizationPage — notifiche della campanella', () => {
  const retention = (days: number | null): GqlMock => ({
    request: { query: GET_TENANT_INAPP_RETENTION }, result: { data: { tenantInAppRetentionDays: days } }, maxUsageCount: Number.POSITIVE_INFINITY,
  })

  it('mostra i giorni scelti e salva quelli nuovi', async () => {
    const seen: unknown[] = []
    const save: GqlMock = { request: { query: SET_TENANT_INAPP_RETENTION, variables: (v) => { seen.push(v); return true } }, result: { data: { setTenantInAppRetentionDays: 90 } } }
    const { user } = renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions(null), retention(30), save] })
    const input = await screen.findByLabelText('Keep for (days)')
    await waitFor(() => expect(input).toHaveValue(30))
    await user.clear(input)
    await user.type(input, '90')
    await user.click(screen.getAllByRole('button', { name: 'Save' }).find((b) => b.closest('section, div')?.textContent?.includes('Keep for'))!)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Notification retention updated'))
    expect(seen).toEqual([{ days: 90 }])
  })

  it('senza una durata scelta lo dice', async () => {
    renderWithProviders(<OrganizationPage />, { route: '/settings/organization', mocks: [language, zones('Europe/Rome'), calendar(FACTORY), portalOptions(null), retention(null)] })
    expect(await screen.findByText(/No duration has been chosen/)).toBeInTheDocument()
  })
})
