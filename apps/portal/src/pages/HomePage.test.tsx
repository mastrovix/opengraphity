/**
 * THE PORTAL HOME.
 *
 * What somebody who spends two minutes a year here needs: how many tickets
 * they have open, the last few, and the two ways out — open a ticket, or
 * search the Knowledge Base.
 *
 * Opening a ticket is a PERMISSION (`portal.submit`, wave 7): without it the
 * shortcut is not offered, rather than offered and refused by the API on
 * submit.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { HomePage } from './HomePage'
import { GET_ME, GET_MY_TICKETS, GET_MY_TICKET_STATS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const sempre = Number.POSITIVE_INFINITY

const me = (over: Record<string, unknown> = {}, permissions = ['portal.read', 'portal.submit']): GqlMock => ({
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'u1', name: 'Anna Rossi', email: 'anna@acme.example', role: 'end_user', permissions, language: 'en', ...over } } },
  maxUsageCount: sempre,
})
const stats = (s: Record<string, number> | null): GqlMock => ({
  request: { query: GET_MY_TICKET_STATS },
  result: { data: { myTicketStats: s ? { __typename: 'TicketStats', ...s } : null } },
  maxUsageCount: sempre,
})
const ticket = (over: Record<string, unknown> = {}) => ({
  __typename: 'Ticket', id: 't1', number: 'INC-1', type: 'incident', title: 'VPN down',
  status: 'in_progress', statusCategory: 'active', statusLabel: 'In lavorazione',
  priority: 'high', priorityLabel: 'High', priorityColor: 'danger', category: 'network',
  createdAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-21T09:00:00Z', assignedTeam: null, ...over,
})
const miei = (items: unknown[]): GqlMock => ({
  request: { query: GET_MY_TICKETS, variables: () => true },
  result: { data: { myTickets: { __typename: 'TicketsResult', total: items.length, items } } },
  maxUsageCount: sempre,
})

const mostra = (mocks: GqlMock[]) => renderWithProviders(<HomePage />, { mocks })

describe('the greeting and the counters', () => {
  it('greets by name and shows the three counters', async () => {
    mostra([me(), stats({ open: 2, inProgress: 1, resolved: 5, total: 8 }), miei([])])
    expect(await screen.findByText(/Anna Rossi/)).toBeInTheDocument()
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
  })

  it('falls back to the e-mail when there is no name', async () => {
    mostra([me({ name: null }), stats(null), miei([])])
    expect(await screen.findByText(/anna@acme.example/)).toBeInTheDocument()
  })

  it('with no counters yet the page still renders', async () => {
    mostra([me(), stats(null), miei([])])
    expect(await screen.findByText(/Anna Rossi/)).toBeInTheDocument()
  })
})

describe('the recent tickets', () => {
  it('lists them with the customer\'s own step label, linked to the detail', async () => {
    // The step label is the customer's word for it (wave 7 · D-15), not the
    // internal status.
    mostra([me(), stats(null), miei([ticket()])])
    expect(await screen.findByText('VPN down')).toBeInTheDocument()
    expect(screen.getByText('In lavorazione')).toBeInTheDocument()
    expect(screen.getAllByRole('link').some((l) => l.getAttribute('href') === '/tickets/t1')).toBe(true)
  })

  it('with none it says so, and offers the way to open one', async () => {
    mostra([me(), stats(null), miei([])])
    expect(await screen.findByText('You have no open tickets.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Need help?' })).toBeInTheDocument()
  })

  it('without portal.submit the empty state offers no way to open one', async () => {
    mostra([me({}, ['portal.read']), stats(null), miei([])])
    expect(await screen.findByText('You have no open tickets.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Need help?' })).toBeNull()
  })

  it('leads to the whole list', async () => {
    mostra([me(), stats(null), miei([ticket()])])
    await screen.findByText('VPN down')
    expect(screen.getAllByRole('link').some((l) => l.getAttribute('href') === '/tickets')).toBe(true)
  })
})

describe('the two shortcuts', () => {
  it('opening a ticket goes to the form', async () => {
    const { user } = mostra([me(), stats(null), miei([])])
    await user.click(await screen.findByText('Open a new ticket'))
    await waitFor(() => { expect(screen.getByTestId('location').textContent).toBe('/tickets/new') })
  })

  it('without portal.submit the shortcut is not offered at all', async () => {
    mostra([me({}, ['portal.read']), stats(null), miei([])])
    await screen.findByText(/Anna Rossi/)
    expect(screen.queryByText('Open a new ticket')).toBeNull()
  })

  it('searching the Knowledge Base goes to the KB', async () => {
    const { user } = mostra([me(), stats(null), miei([])])
    await user.click(await screen.findByText('Search the Knowledge Base'))
    await waitFor(() => { expect(screen.getByTestId('location').textContent).toBe('/kb') })
  })
})
