/**
 * A SERVICE REQUEST HAS A TEAM, AND ITS ASSIGNEE IS ONE OF THE MEMBERS (D56,
 * tour of 23 Sep 2026). The API refuses an assignee outside the request's
 * team, so the page offers only the members, and without a team it says to
 * assign one first instead of offering everybody.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { RequestAssignment, membersWhoCanTake, type AssignableUser, type RequestAssignmentView } from './RequestAssignment'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const person = (id: string, name: string, teams: string[], over: Partial<AssignableUser> = {}): AssignableUser => ({
  id, name, permissions: ['ticket.assignable'], active: true, teams: teams.map((tid) => ({ id: tid })), ...over,
})
const USERS = [
  person('u-olga', 'Olga', ['t-desk']),
  person('u-otto', 'Otto', ['t-net']),
  person('u-vera', 'Vera', ['t-desk'], { permissions: [] }),
  person('u-gone', 'Gone', ['t-desk'], { active: false }),
]
const TEAMS = [
  { id: 't-desk', name: 'SUP_Service Desk', type: 'support', isChangeManager: false },
  { id: 't-net', name: 'SUP_Network', type: 'support', isChangeManager: false },
  { id: 't-own', name: 'OWN_Finance', type: 'owner', isChangeManager: false },
]
const open = (over: Partial<RequestAssignmentView> = {}): RequestAssignmentView => ({ id: 'sr-1', team: null, assignee: null, completedAt: null, ...over })

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  apolloFinto.risposte['GetAssignableUsers'] = { users: USERS }
  apolloFinto.risposte['GetTeamChoices'] = { teams: TEAMS }
})

describe('membersWhoCanTake', () => {
  it('active, allowed to receive tickets, and a member of the team', () => {
    expect(membersWhoCanTake(USERS, 't-desk').map((u) => u.id)).toEqual(['u-olga'])
    expect(membersWhoCanTake(USERS, 't-net').map((u) => u.id)).toEqual(['u-otto'])
  })
})

describe('RequestAssignment', () => {
  it('without a team: the assignee waits and says why; the team is chosen among the support teams', async () => {
    const onChanged = vi.fn(async () => undefined)
    apolloFinto.esiti['AssignServiceRequestToTeam'] = { data: { assignServiceRequestToTeam: { id: 'sr-1' } } }
    const { user } = renderWithProviders(<RequestAssignment request={open()} onChanged={onChanged} />)
    expect(screen.getByText('Assign a team first: the assignee is one of its members.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).not.toBeInTheDocument()
    // Nobody to offer yet: the people are not even read.
    expect(apolloFinto.chiamate['GetAssignableUsers']).toBeUndefined()
    const assignTeam = screen.getByRole('button', { name: 'Assign team' })
    expect(assignTeam).toBeDisabled()
    await user.type(screen.getByRole('combobox', { name: 'Team' }), 'SUP')
    expect(screen.queryByRole('option', { name: 'OWN_Finance' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'SUP_Network' }))
    await user.click(assignTeam)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Team assigned'))
    expect(apolloFinto.chiamata('AssignServiceRequestToTeam')).toEqual({ id: 'sr-1', teamId: 't-net' })
    expect(onChanged).toHaveBeenCalled()
  })

  it('with a team: only its members who can take tickets are offered, and the choice is sent', async () => {
    apolloFinto.esiti['AssignServiceRequestToUser'] = { data: { assignServiceRequestToUser: { id: 'sr-1' } } }
    const { user } = renderWithProviders(<RequestAssignment request={open({ team: { id: 't-desk', name: 'SUP_Service Desk' } })} onChanged={vi.fn(async () => undefined)} />)
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('SUP_Service Desk')
    const select = screen.getByRole('combobox', { name: 'Assignee' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Nobody —', 'Olga'])
    await user.selectOptions(select, 'u-olga')
    await user.click(screen.getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Request assigned'))
    expect(apolloFinto.chiamata('AssignServiceRequestToUser')).toEqual({ id: 'sr-1', userId: 'u-olga' })
  })

  it('an assignee from before the team stays visible, and a team with nobody to take it says so', () => {
    apolloFinto.risposte['GetAssignableUsers'] = { users: [person('u-otto', 'Otto', ['t-net'])] }
    renderWithProviders(<RequestAssignment request={open({ team: { id: 't-desk', name: 'SUP_Service Desk' }, assignee: { id: 'u-otto', name: 'Otto' } })} onChanged={vi.fn(async () => undefined)} />)
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveValue('u-otto')
    expect(screen.getByText('The team has no members: add them in Teams.')).toBeInTheDocument()
  })

  it('people that cannot be read are said, not shown as an empty team', () => {
    apolloFinto.erroriQuery['GetAssignableUsers'] = new Error('users down')
    renderWithProviders(<RequestAssignment request={open({ team: { id: 't-desk', name: 'SUP_Service Desk' } })} onChanged={vi.fn(async () => undefined)} />)
    expect(screen.getByRole('alert')).toHaveTextContent('People not loaded: users down')
  })

  it('a completed request shows its team and assignee, nothing to change', () => {
    renderWithProviders(<RequestAssignment request={open({ completedAt: '2026-09-23T10:00:00Z', team: { id: 't-desk', name: 'SUP_Service Desk' }, assignee: { id: 'u-olga', name: 'Olga' } })} onChanged={vi.fn(async () => undefined)} />)
    expect(screen.getByText('SUP_Service Desk')).toBeInTheDocument()
    expect(screen.getByText('Olga')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
