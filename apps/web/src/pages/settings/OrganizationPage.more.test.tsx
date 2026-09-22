/**
 * ORGANIZATION SETTINGS: the choices that apply to everybody in the tenant.
 *
 * The base test file covers reading each section and the "create" paths. This
 * one covers what an administrator does next, and what breaks for everyone if
 * it regresses:
 *  - changing the company language must switch the UI at once for people who
 *    never chose their own language, and must NOT override a personal choice;
 *  - an unreadable settings query must show an error with a retry, never an
 *    empty page that looks like "nothing configured";
 *  - editing a calendar must update THAT calendar (not create a copy), and a
 *    calendar can only be deleted after an explicit confirmation;
 *  - the portal severity choice must send exactly the values ticked, with the
 *    words typed per language;
 *  - the notification retention must refuse a value the API rejects.
 * The sub-sections living in their own files have their own tests and are
 * stubbed here, so this file is about the page and its inline sections.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { apolloFinto } from '@/test/apolloFinto'
import { renderWithProviders } from '@/test/utils'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { applicaLinguaDelCliente, linguaSceltaDallUtente } from '@/i18n/tenantLanguage'
import { OrganizationPage } from './OrganizationPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))
vi.mock('@/i18n/tenantLanguage', () => ({
  applicaLinguaDelCliente: vi.fn(async () => {}),
  linguaSceltaDallUtente: vi.fn(() => false),
}))
vi.mock('./organization/OrganizationNameSection', () => ({ OrganizationNameSection: () => null }))
vi.mock('./organization/BrandSection', () => ({ BrandSection: () => null }))
vi.mock('./organization/TicketNumberingSection', () => ({ TicketNumberingSection: () => <p>numbering-section</p> }))
vi.mock('./organization/AttachmentPolicySection', () => ({ AttachmentPolicySection: () => null }))
vi.mock('./organization/AISection', () => ({ AISection: () => <p>ai-section</p> }))
vi.mock('./organization/ScriptingSection', () => ({ ScriptingSection: () => null }))

// Stable references, as the real provider gives: the section re-seeds its
// draft whenever the vocabulary changes, so a fresh array per render would loop.
const SEVERITY_ENTRIES = [
  { value: 'low', label: 'Low', labels: [{ language: 'it', label: 'Bassa' }] },
  { value: 'high', label: 'High', labels: [] },
] as never
const vocab = (withSeverity: boolean): DomainVocabularies => ({
  valuesOf: () => null,
  labelOf: () => null,
  colorOf: () => null,
  entriesOf: (name) => (withSeverity && name === 'severity' ? SEVERITY_ENTRIES : null),
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
})
const VOCAB_WITH = vocab(true)
const VOCAB_WITHOUT = vocab(false)

function page(route = '/settings/organization', withSeverity = true) {
  const Wrap = ({ children }: { children: ReactNode }) => (
    <DomainVocabularyContext.Provider value={withSeverity ? VOCAB_WITH : VOCAB_WITHOUT}>{children}</DomainVocabularyContext.Provider>
  )
  return renderWithProviders(<Wrap><OrganizationPage /></Wrap>, { route })
}

const CAL = {
  id: 'cal-1', name: 'Office hours', days: [5, 1, 3], start: '09:00', end: '17:00', holidays: ['2026-12-25', '2026-12-26'],
  usedBySlaPolicies: [], usedByOlaContracts: [], usedByWorkflowSteps: [],
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(applicaLinguaDelCliente).mockClear()
  vi.mocked(linguaSceltaDallUtente).mockReturnValue(false)
  apolloFinto.risposte['GetTenantLanguageSettings'] = { tenantLanguageSettings: { available: ['en', 'it'], defaultLanguage: 'en', fallback: 'en' } }
  apolloFinto.risposte['GetTenantTimezoneSettings'] = { tenantTimezoneSettings: { timezone: 'UTC', available: ['UTC', 'Europe/Rome'] } }
  apolloFinto.risposte['GetTenantInAppRetention'] = { tenantInAppRetentionDays: 30 }
  apolloFinto.risposte['GetServiceCalendars'] = { serviceCalendars: [CAL] }
  apolloFinto.risposte['GetPortalSeverityOptions'] = { portalSeverityOptions: [{ value: 'low', labels: [{ language: 'en', label: 'Minor' }] }] }
})

describe('OrganizationPage — company language', () => {
  it('saving a new language applies it at once to people without a personal choice', async () => {
    apolloFinto.esiti['SetTenantDefaultLanguage'] = { data: { setTenantDefaultLanguage: { available: ['en', 'it'], defaultLanguage: 'it', fallback: 'en' } } }
    const { user } = page()
    const select = screen.getByLabelText('Default language')
    expect(screen.getByText(/keeps reading that one/)).toBeInTheDocument()
    await user.selectOptions(select, 'it')
    expect(apolloFinto.chiamata('SetTenantDefaultLanguage')).toEqual({ language: 'it' })
    expect(toast.success).toHaveBeenCalledWith('Organization language updated')
    expect(applicaLinguaDelCliente).toHaveBeenCalledWith('it')
  })

  it('does not override the language a person chose in the Profile', async () => {
    vi.mocked(linguaSceltaDallUtente).mockReturnValue(true)
    apolloFinto.esiti['SetTenantDefaultLanguage'] = { data: { setTenantDefaultLanguage: { available: ['en', 'it'], defaultLanguage: 'it', fallback: 'en' } } }
    const { user } = page()
    await user.selectOptions(screen.getByLabelText('Default language'), 'it')
    expect(toast.success).toHaveBeenCalled()
    expect(applicaLinguaDelCliente).not.toHaveBeenCalled()
  })

  it('a failed save is reported to the user', async () => {
    apolloFinto.esiti['SetTenantDefaultLanguage'] = { error: new Error('forbidden') }
    const { user } = page()
    await user.selectOptions(screen.getByLabelText('Default language'), 'it')
    expect(toast.error).toHaveBeenCalledWith('forbidden')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('no language chosen yet: says which one is in use instead of pretending one was chosen', () => {
    apolloFinto.risposte['GetTenantLanguageSettings'] = { tenantLanguageSettings: { available: ['en', 'it'], defaultLanguage: null, fallback: 'en' } }
    page()
    expect(screen.getByLabelText('Default language')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Not configured' })).toBeDisabled()
    expect(screen.getByText(/Nobody has chosen one yet: the product reads in/)).toBeInTheDocument()
  })

  it('an unreadable language setting shows an error with a retry, not an empty page', async () => {
    apolloFinto.erroriQuery['GetTenantLanguageSettings'] = new Error('language settings unavailable')
    const { user } = page()
    expect(screen.getByText('language settings unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('OrganizationPage — tabs', () => {
  it('the tab lives in the address, and General clears it', async () => {
    const { user } = page('/settings/organization?tab=tickets')
    expect(screen.getByText('numbering-section')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'AI' }))
    expect(screen.getByText('ai-section')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'General' }))
    expect(screen.getByLabelText('Default language')).toBeInTheDocument()
  })

  it('an unknown tab in the address falls back to General', () => {
    page('/settings/organization?tab=nonsense')
    expect(screen.getByLabelText('Default language')).toBeInTheDocument()
  })
})

describe('OrganizationPage — time zone and retention', () => {
  it('the time zone section reports its own error with a retry', async () => {
    apolloFinto.erroriQuery['GetTenantTimezoneSettings'] = new Error('tz down')
    const { user } = page()
    expect(screen.getByText('tz down')).toBeInTheDocument()
    // The rest of the page is still usable.
    expect(screen.getByLabelText('Default language')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a failed time zone save is reported', async () => {
    apolloFinto.esiti['SetTenantTimezone'] = { error: new Error('tz refused') }
    const { user } = page()
    await user.selectOptions(screen.getByLabelText('Time zone'), 'Europe/Rome')
    expect(toast.error).toHaveBeenCalledWith('tz refused')
  })

  it('saves a new retention and refuses one the API would reject', async () => {
    const { user } = page()
    const input = screen.getByLabelText('Keep for (days)')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(input).toHaveValue(30)
    // Unchanged: nothing to save.
    expect(save).toBeDisabled()
    await user.clear(input)
    await user.type(input, '4000')
    expect(save).toBeDisabled()
    await user.clear(input)
    await user.type(input, '90')
    await user.click(save)
    expect(apolloFinto.chiamata('SetTenantInAppRetention')).toEqual({ days: 90 })
    expect(toast.success).toHaveBeenCalledWith('Notification retention updated')
  })

  it('a failed retention save is reported, and a query error shows a retry', async () => {
    apolloFinto.esiti['SetTenantInAppRetention'] = { error: new Error('nope') }
    const { user } = page()
    const input = screen.getByLabelText('Keep for (days)')
    await user.clear(input)
    await user.type(input, '10')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(toast.error).toHaveBeenCalledWith('nope')
  })

  it('an unreadable retention says so, with a retry', async () => {
    apolloFinto.erroriQuery['GetTenantInAppRetention'] = new Error('retention down')
    const { user } = page()
    expect(screen.getByText('retention down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('OrganizationPage — service calendars', () => {
  it('lists days from Monday, with the holiday count', () => {
    page('/settings/organization?tab=service')
    const row = screen.getByText('Office hours').closest('li')!
    // Stored as [5,1,3]: read in week order, not storage order.
    expect(row).toHaveTextContent('Mon Wed Fri · 09:00–17:00 · 2 holidays')
    expect(row).toHaveTextContent('Not used')
  })

  it('edits the chosen calendar in place, and says who is affected', async () => {
    apolloFinto.risposte['GetServiceCalendars'] = { serviceCalendars: [{ ...CAL, usedByOlaContracts: ['Network vendor'] }] }
    const { user } = page('/settings/organization?tab=service')
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Edit service calendar')).toBeInTheDocument()
    expect(within(dialog).getByText('Changes apply to new SLAs of: Network vendor.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Holidays')).toHaveValue('2026-12-25, 2026-12-26')

    const name = within(dialog).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, '  Office hours EU  ')
    // Untick Wednesday, tick Tuesday.
    await user.click(within(dialog).getByRole('checkbox', { name: 'Wednesday' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'Tuesday' }))
    const holidays = within(dialog).getByLabelText('Holidays')
    await user.clear(holidays)
    await user.type(holidays, '2026-01-01; 2026-08-15 ,')
    await user.click(within(dialog).getByRole('button', { name: 'Save calendar' }))

    expect(apolloFinto.chiamata('UpdateServiceCalendar')).toEqual({
      id: 'cal-1', name: 'Office hours EU',
      calendar: { days: [1, 2, 5], start: '09:00', end: '17:00', holidays: ['2026-01-01', '2026-08-15'] },
    })
    expect(apolloFinto.chiamate['CreateServiceCalendar']).toBeUndefined()
    expect(toast.success).toHaveBeenCalledWith('Service calendar updated')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('cancel or Escape closes the editor without saving', async () => {
    const { user } = page('/settings/organization?tab=service')
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'New calendar' }))
    expect(within(screen.getByRole('dialog')).getByLabelText('Name')).toHaveValue('')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamate['UpdateServiceCalendar']).toBeUndefined()
  })

  it('deletes an unused calendar only after confirmation', async () => {
    const { user } = page('/settings/organization?tab=service')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    // First time: the user says no.
    let dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete this service calendar?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(apolloFinto.chiamate['DeleteServiceCalendar']).toBeUndefined()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteServiceCalendar')).toEqual({ id: 'cal-1' }))
    expect(toast.success).toHaveBeenCalledWith('Service calendar deleted')
  })

  it('a calendar query error shows a retry', async () => {
    apolloFinto.erroriQuery['GetServiceCalendars'] = new Error('calendars down')
    const { user } = page('/settings/organization?tab=service')
    expect(screen.getByText('calendars down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a failed calendar save keeps the editor open and reports the error', async () => {
    apolloFinto.esiti['UpdateServiceCalendar'] = { error: new Error('overlap') }
    const { user } = page('/settings/organization?tab=service')
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save calendar' }))
    expect(toast.error).toHaveBeenCalledWith('overlap')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('OrganizationPage — portal severities', () => {
  it('sends exactly the ticked values, with the words typed per language', async () => {
    const { user } = page('/settings/organization?tab=portal')
    const offerLow = screen.getByRole('checkbox', { name: 'Offer Low in the portal' })
    const offerHigh = screen.getByRole('checkbox', { name: 'Offer High in the portal' })
    expect(offerLow).toBeChecked()
    expect(offerHigh).not.toBeChecked()
    // The dictionary label is the placeholder, per language (with fallback to the generic one).
    const highInputs = screen.getAllByRole('textbox', { name: /Label of High in/ })
    // Not offered: its labels cannot be typed.
    highInputs.forEach((i) => expect(i).toBeDisabled())
    expect(screen.getAllByRole('textbox', { name: /Label of Low in/ }).map((i) => i.getAttribute('placeholder'))).toEqual(['Low', 'Bassa'])

    await user.click(offerHigh)
    await user.type(highInputs[1]!, 'Alta')
    await user.click(screen.getByRole('button', { name: 'Save portal severities' }))
    expect(apolloFinto.chiamata('SetPortalSeverityOptions')).toEqual({
      options: [
        { value: 'low', labels: [{ language: 'en', label: 'Minor' }, { language: 'it', label: '' }] },
        { value: 'high', labels: [{ language: 'en', label: '' }, { language: 'it', label: 'Alta' }] },
      ],
    })
    expect(toast.success).toHaveBeenCalledWith('Portal severities updated')
  })

  it('with nothing ticked the save stays off; a failed save is reported', async () => {
    apolloFinto.esiti['SetPortalSeverityOptions'] = { error: new Error('bad options') }
    const { user } = page('/settings/organization?tab=portal')
    const offerLow = screen.getByRole('checkbox', { name: 'Offer Low in the portal' })
    await user.click(offerLow)
    const save = screen.getByRole('button', { name: 'Save portal severities' })
    expect(save).toBeDisabled()
    await user.click(offerLow)
    await user.click(save)
    expect(toast.error).toHaveBeenCalledWith('bad options')
  })

  it('an unreadable portal choice shows a retry', async () => {
    apolloFinto.erroriQuery['GetPortalSeverityOptions'] = new Error('portal down')
    const { user } = page('/settings/organization?tab=portal')
    expect(screen.getByText('portal down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('without the severity vocabulary the table is not shown', () => {
    page('/settings/organization?tab=portal', false)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
