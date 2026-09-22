/**
 * The excluded CI types of a ticket type (CM-8): the states AROUND the
 * checkbox list. A ticket type that does not link CIs must say so instead of
 * offering a list that means nothing; a failed load must be an error the admin
 * reads, not an empty list that looks like «nothing excluded» (saving it would
 * wipe the real exclusions); a failed save must surface; and unticking a saved
 * exclusion must send the list without it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ITILTypeCIExclusions } from './ITILTypeCIExclusions'
import { GET_TICKET_CI_EXCLUSIONS } from '@/graphql/queries'
import { SET_TICKET_CI_EXCLUSIONS } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const CI_TYPES = [
  { id: 't1', name: 'server', label: 'Server' },
  { id: 't2', name: 'certificate', label: 'Certificate' },
]
const read = (ciTypes: string[]): GqlMock => ({
  request: { query: GET_TICKET_CI_EXCLUSIONS, variables: { ticketType: 'change' } },
  result: { data: { ticketCIExclusions: [{ __typename: 'TicketCIExclusions', ticketType: 'change', ciTypes }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('ITILTypeCIExclusions — states around the list', () => {
  it('a ticket type that does not link CIs says so and asks the server nothing', () => {
    // No mocks: a query would be an unmatched request and fail the render.
    renderWithProviders(<ITILTypeCIExclusions ticketType="knowledge_article" ciTypes={CI_TYPES} />, { mocks: [] })
    expect(screen.getByText('This ticket type is not linked to CIs.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('a failed load is an alert, never an empty list that could be saved over the real one', async () => {
    const failing: GqlMock = {
      request: { query: GET_TICKET_CI_EXCLUSIONS, variables: { ticketType: 'change' } },
      error: new Error('graph unavailable'),
    }
    renderWithProviders(<ITILTypeCIExclusions ticketType="change" ciTypes={CI_TYPES} />, { mocks: [failing] })
    expect(await screen.findByRole('alert')).toHaveTextContent('The exclusions could not be loaded: graph unavailable')
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument()
  })

  it('unticking a saved exclusion sends the list without it, and confirms', async () => {
    const seen: unknown[] = []
    const save: GqlMock = {
      request: { query: SET_TICKET_CI_EXCLUSIONS, variables: (v) => { seen.push(v); return true } },
      result: { data: { setTicketCIExclusions: { __typename: 'TicketCIExclusions', ticketType: 'change', ciTypes: ['server'] } } },
    }
    const { user } = renderWithProviders(<ITILTypeCIExclusions ticketType="change" ciTypes={CI_TYPES} />, { mocks: [read(['server', 'certificate']), save] })
    expect(await screen.findByText('Excluded CI types: 2.')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Certificate' }))
    expect(screen.getByText('Excluded CI types: 1.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(seen).toEqual([{ ticketType: 'change', ciTypes: ['server'] }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Changes saved'))
  })

  it('a refused save is shown to the admin', async () => {
    const save: GqlMock = {
      request: { query: SET_TICKET_CI_EXCLUSIONS, variables: () => true },
      error: new Error('not allowed'),
    }
    const { user } = renderWithProviders(<ITILTypeCIExclusions ticketType="change" ciTypes={CI_TYPES} />, { mocks: [read([]), save] })
    await user.click(await screen.findByRole('checkbox', { name: 'Server' }))
    await user.click(screen.getByRole('button', { name: /Save/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not allowed')))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
