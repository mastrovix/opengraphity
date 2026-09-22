/**
 * OLA / UC CONTRACTS: where an administrator writes them.
 *
 * A contract decides which team is measured on a ticket and against what
 * target. If this page regresses, the consequences are silent and late: a
 * contract saved without a way of counting time, with a compliance threshold
 * above the target, or with a supplier team that is actually internal, is
 * accepted and then colours the OLA/UC report wrongly for months. So these
 * tests pin what the form refuses, what it sends, and that the accountable
 * team offered always has the Sourcing its party type demands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { OLAContract } from './OLAContractsPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { OLAContractsPage, olaMinutes, olaScopeLabel } = await import('./OLAContractsPage')

const t = i18n.getFixedT('en')

const contract = (over: Partial<OLAContract> = {}): OLAContract => ({
  id: 'c1', type: 'ola', name: 'Network restore', description: 'Four hours', entityType: 'incident',
  responseMinutes: 30, resolveMinutes: 240, businessHours: false, calendarId: null, calendarName: null,
  complianceTarget: 99, complianceWarning: 95, partyType: 'team', partyName: null, teamId: 't-in',
  teamName: 'Network', enabled: true, createdAt: '2026-09-01T00:00:00Z', ...over,
})

const TEAMS = [
  { id: 't-in', name: 'Network', sourcing: 'internal' },
  { id: 't-ext', name: 'Acme Hosting', sourcing: 'external' },
  { id: 't-none', name: 'Unclassified', sourcing: null },
]

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [] }
  apolloFinto.risposte['GetTeams'] = { teams: TEAMS }
  apolloFinto.risposte['GetServiceCalendars'] = { serviceCalendars: [{ id: 'cal-1', name: 'Office hours' }] }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Disruption' }] }
})

const dialog = () => screen.getByRole('dialog')
const field = (label: RegExp) => within(dialog()).getByLabelText(label)

describe('olaMinutes', () => {
  // The same short units as the SLA policies: the two pages are read side by side.
  it('formats minutes, hours and days, and shows a dash for no value', () => {
    expect(olaMinutes(null, t)).toBe('—')
    expect(olaMinutes(45, t)).toBe('45min')
    expect(olaMinutes(120, t)).toBe('2h')
    expect(olaMinutes(90, t)).toBe('1h 30min')
    expect(olaMinutes(2880, t)).toBe('2d')
    expect(olaMinutes(1500, t)).toBe('1d 1h')
  })
})

describe('olaScopeLabel', () => {
  it('"any" is "All", any other scope is the customer label of the ITIL type', () => {
    expect(olaScopeLabel('any', t, () => 'x')).toBe('All')
    expect(olaScopeLabel('incident', t, (e) => `label:${e}`)).toBe('label:incident')
  })
})

describe('list', () => {
  it('no contract: the empty state explains what an OLA and a UC are', () => {
    renderWithProviders(<OLAContractsPage />)
    expect(screen.getByText('No contract yet')).toBeInTheDocument()
  })

  it('a failed load shows the error with a retry that reloads', async () => {
    apolloFinto.erroriQuery['GetOLAContracts'] = new Error('boom')
    const { user } = renderWithProviders(<OLAContractsPage />)
    expect(screen.getByText(/boom/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry|try again/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('each row shows type, customer scope label, team, targets, time counting and compliance', () => {
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [
      contract(),
      contract({ id: 'c2', type: 'uc', name: 'Hosting UC', entityType: 'any', teamName: null, partyName: 'Legacy supplier',
        businessHours: true, calendarId: 'cal-1', calendarName: 'Office hours', complianceTarget: null }),
      // A contract on business hours whose calendar is gone: flagged, not hidden.
      contract({ id: 'c3', name: 'Orphan', teamName: null, partyName: null, businessHours: true, calendarName: null }),
    ] }
    renderWithProviders(<OLAContractsPage />)
    const rows = screen.getAllByRole('row')
    const first = rows.find((r) => within(r).queryByText('Network restore'))!
    expect(within(first).getByText('OLA')).toBeInTheDocument()
    expect(within(first).getByText('Disruption')).toBeInTheDocument()
    expect(within(first).getByText('30min')).toBeInTheDocument()
    expect(within(first).getByText('4h')).toBeInTheDocument()
    expect(within(first).getByText('24×7')).toBeInTheDocument()
    expect(within(first).getByText('99%')).toBeInTheDocument()
    const second = rows.find((r) => within(r).queryByText('Hosting UC'))!
    expect(within(second).getByText('UC')).toBeInTheDocument()
    expect(within(second).getByText('All')).toBeInTheDocument()
    expect(within(second).getByText('Legacy supplier')).toBeInTheDocument()
    expect(within(second).getByText('Office hours')).toBeInTheDocument()
    const third = rows.find((r) => within(r).queryByText('Orphan'))!
    expect(within(third).getByText('No calendar')).toBeInTheDocument()
  })

  it('the switch deactivates a contract, reloads, and says it no longer alerts', async () => {
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [contract()] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await user.click(screen.getByRole('switch', { name: 'Toggle Network restore' }))
    expect(apolloFinto.chiamata('UpdateOLAContract')).toEqual({ id: 'c1', input: { enabled: false } })
    // Clicking the switch must not also open the edit dialog.
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/deactivated/)))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('the switch re-activates a disabled contract', async () => {
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [contract({ enabled: false })] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await user.click(screen.getByRole('switch', { name: 'Toggle Network restore' }))
    expect(apolloFinto.chiamata('UpdateOLAContract')).toEqual({ id: 'c1', input: { enabled: true } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/active: it counts again/)))
  })
})

describe('create', () => {
  const openNew = async (user: ReturnType<typeof renderWithProviders>['user']) => {
    await user.click(screen.getByRole('button', { name: 'New contract' }))
    expect(within(dialog()).getByText('New OLA/UC contract')).toBeInTheDocument()
  }

  it('save stays disabled until the contract has a name', async () => {
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    const save = within(dialog()).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.type(field(/Name \*/), '   ')
    expect(save).toBeDisabled()
  })

  it('refuses to save without a choice of how time counts', async () => {
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    await user.type(field(/Name \*/), 'X')
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Choose how time counts/))
    expect(apolloFinto.chiamata('CreateOLAContract')).toBeUndefined()
  })

  it('refuses a threshold that is not below the target', async () => {
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    await user.type(field(/Name \*/), 'X')
    await user.selectOptions(field(/Time counts/), '24x7')
    await user.type(field(/Compliance target/), '90')
    await user.type(field(/Attention threshold/), '95')
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/compliance target must be/))
    expect(apolloFinto.chiamata('CreateOLAContract')).toBeUndefined()
  })

  it('a UC with an external team on a calendar is sent whole, then the dialog closes', async () => {
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    await user.selectOptions(field(/^Type$/), 'uc')
    await user.selectOptions(field(/Scope/), 'change')
    await user.type(field(/Name \*/), '  Hosting UC  ')
    await user.type(field(/Description/), '  ')
    await user.clear(field(/Response target/))
    await user.type(field(/Response target/), '15')
    await user.clear(field(/Resolution target/))
    await user.type(field(/Resolution target/), '600')
    await user.selectOptions(field(/Time counts/), 'cal-1')
    await user.type(field(/Compliance target/), '99.5')
    await user.type(field(/Attention threshold/), '97')
    await user.selectOptions(field(/Accountable party/), 'supplier')
    await user.selectOptions(field(/External team/), 't-ext')
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('CreateOLAContract')).toEqual({ input: {
      type: 'uc', name: 'Hosting UC', description: null, entityType: 'change',
      responseMinutes: 15, resolveMinutes: 600, calendarId: 'cal-1',
      complianceTarget: 99.5, complianceWarning: 97, partyType: 'supplier', teamId: 't-ext',
    } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('Contract created')
  })

  it('an internal team is offered only for "internal team", an external one only for "supplier"', async () => {
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    const options = (label: RegExp) => within(field(label) as HTMLElement).getAllByRole('option').map((o) => o.textContent)
    expect(options(/Responsible team/)).toEqual(['Choose a team...', 'Network'])
    await user.selectOptions(field(/Responsible team/), 't-in')
    await user.selectOptions(field(/Accountable party/), 'supplier')
    // Switching party type clears the team: the one picked before has the other Sourcing.
    expect(field(/External team/)).toHaveValue('')
    expect(options(/External team/)).toEqual(['Choose a team...', 'Acme Hosting'])
  })

  it('when no team has the right Sourcing, the dialog says where to set it', async () => {
    apolloFinto.risposte['GetTeams'] = { teams: [] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    expect(within(dialog()).getByText(/No team with Sourcing = Internal/)).toBeInTheDocument()
    await user.selectOptions(field(/Accountable party/), 'supplier')
    expect(within(dialog()).getByText(/No team with Sourcing = External/)).toBeInTheDocument()
  })

  it('a rejected save keeps the dialog open and shows the error', async () => {
    apolloFinto.esiti['CreateOLAContract'] = { error: new Error('team is not internal') }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    await user.type(field(/Name \*/), 'X')
    await user.selectOptions(field(/Time counts/), '24x7')
    await user.type(field(/Compliance target/), '99')
    await user.type(field(/Attention threshold/), '90')
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('team is not internal'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('Escape closes the dialog too', async () => {
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancel closes the dialog without saving', async () => {
    const { user } = renderWithProviders(<OLAContractsPage />)
    await openNew(user)
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['CreateOLAContract']).toBeUndefined()
  })
})

describe('edit and delete', () => {
  it('clicking a row opens it filled in; the type is locked; saving updates it without the type', async () => {
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [contract({ description: null, businessHours: true, calendarId: 'cal-1' })] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await user.click(screen.getByText('Network restore'))
    expect(within(dialog()).getByText('Edit the OLA/UC contract')).toBeInTheDocument()
    expect(field(/Name \*/)).toHaveValue('Network restore')
    expect(field(/^Type$/)).toBeDisabled()
    expect(field(/Time counts/)).toHaveValue('cal-1')
    expect(field(/Compliance target/)).toHaveValue(99)
    await user.clear(field(/Name \*/))
    await user.type(field(/Name \*/), 'Network restored')
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateOLAContract')).toEqual({ id: 'c1', input: {
      name: 'Network restored', description: null, entityType: 'incident', responseMinutes: 30, resolveMinutes: 240,
      calendarId: 'cal-1', complianceTarget: 99, complianceWarning: 95, partyType: 'team', teamId: 't-in',
    } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Contract saved'))
  })

  it('a legacy contract with no party, team or compliance opens with empty fields, not "null"', async () => {
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [contract({
      partyType: null, teamId: null, complianceTarget: null, complianceWarning: null, businessHours: true, calendarId: null,
    })] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await user.click(screen.getByText('Network restore'))
    expect(field(/Accountable party/)).toHaveValue('team')
    expect(field(/Responsible team/)).toHaveValue('')
    expect(field(/Compliance target/)).toHaveValue(null)
    // Business hours without a calendar: the old default must be chosen again, not silently kept.
    expect(field(/Time counts/)).toHaveValue('')
  })

  it('delete asks first; confirming deletes and closes', async () => {
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [contract()] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await user.click(screen.getByText('Network restore'))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Delete the contract «Network restore»?')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Delete' })
    await user.click(buttons.at(-1)!)
    await waitFor(() => expect(apolloFinto.chiamata('DeleteOLAContract')).toEqual({ id: 'c1' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Contract deleted'))
  })

  it('declining the confirmation deletes nothing', async () => {
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [contract()] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await user.click(screen.getByText('Network restore'))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    await screen.findByText('Delete the contract «Network restore»?')
    const cancels = screen.getAllByRole('button', { name: 'Cancel' })
    await user.click(cancels.at(-1)!)
    await waitFor(() => expect(screen.queryByText('Delete the contract «Network restore»?')).toBeNull())
    expect(apolloFinto.chiamate['DeleteOLAContract']).toBeUndefined()
  })

  it('a failed update or delete reports the error', async () => {
    apolloFinto.esiti['UpdateOLAContract'] = { error: new Error('update refused') }
    apolloFinto.esiti['DeleteOLAContract'] = { error: new Error('delete refused') }
    apolloFinto.risposte['GetOLAContracts'] = { olaContracts: [contract()] }
    const { user } = renderWithProviders(<OLAContractsPage />)
    await user.click(screen.getByText('Network restore'))
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('update refused'))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }))
    await screen.findByText('Delete the contract «Network restore»?')
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('delete refused'))
  })
})
