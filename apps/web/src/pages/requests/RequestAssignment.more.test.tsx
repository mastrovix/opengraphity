/**
 * THE TEAM OF A SERVICE REQUEST, WHEN THINGS DO NOT GO SMOOTHLY (D56).
 *
 * The sibling file covers choosing a team and a member. This one covers what
 * happens around it: a team the API refuses is said and the choice stays on
 * screen to try again; while the assignment is on its way the button waits;
 * and a completed request with nobody on it reads as such, not as a blank.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { inFlight, resetInFlight } from '@/test/apolloInFlight'
import { RequestAssignment, type RequestAssignmentView } from './RequestAssignment'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const open = (over: Partial<RequestAssignmentView> = {}): RequestAssignmentView => ({ id: 'sr-1', team: null, assignee: null, completedAt: null, ...over })

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.risposte['GetAssignableUsers'] = { users: [] }
  apolloFinto.risposte['GetTeamChoices'] = { teams: [
    { id: 't-desk', name: 'SUP_Service Desk', type: 'support', isChangeManager: false },
    { id: 't-net', name: 'SUP_Network', type: 'support', isChangeManager: false },
  ] }
})

describe('RequestAssignment: when things do not go smoothly', () => {
  it('a team the API refuses is said, nothing is reread, and the choice stays to try again', async () => {
    apolloFinto.esiti['AssignServiceRequestToTeam'] = { error: new Error('The chosen team no longer exists in this organization') }
    const onChanged = vi.fn(async () => undefined)
    const { user } = renderWithProviders(<RequestAssignment request={open({ team: { id: 't-desk', name: 'SUP_Service Desk' } })} canEdit onChanged={onChanged} />)
    // Choosing the team it already has changes nothing: there is nothing to send.
    await user.click(screen.getByRole('combobox', { name: 'Team' }))
    await user.click(screen.getByRole('option', { name: 'SUP_Service Desk' }))
    expect(screen.getByRole('button', { name: 'Assign team' })).toBeDisabled()
    await user.click(screen.getByRole('combobox', { name: 'Team' }))
    await user.click(screen.getByRole('option', { name: 'SUP_Network' }))
    await user.click(screen.getByRole('button', { name: 'Assign team' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The chosen team no longer exists in this organization'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('SUP_Network')
    expect(screen.getByRole('button', { name: 'Assign team' })).toBeEnabled()
  })

  it('while a team or a person is being assigned the buttons wait and say so', () => {
    inFlight.add('AssignServiceRequestToTeam').add('AssignServiceRequestToUser')
    renderWithProviders(<RequestAssignment request={open({ team: { id: 't-desk', name: 'SUP_Service Desk' } })} canEdit onChanged={vi.fn(async () => undefined)} />)
    const waiting = screen.getAllByRole('button', { name: 'Assigning…' })
    expect(waiting).toHaveLength(2)
    for (const button of waiting) expect(button).toBeDisabled()
  })

  it('a completed request with nobody on it shows dashes, not blanks', () => {
    renderWithProviders(<RequestAssignment request={open({ completedAt: '2026-09-23T10:00:00Z' })} canEdit onChanged={vi.fn(async () => undefined)} />)
    expect(screen.getByText('Team').parentElement!.nextElementSibling).toHaveTextContent('—')
    expect(screen.getByText('Assignee').parentElement!.nextElementSibling).toHaveTextContent('—')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
