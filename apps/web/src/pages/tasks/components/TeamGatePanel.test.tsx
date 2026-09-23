/**
 * NOT YOUR TEAM'S TASK: WHO CAN DO IT, AND A WAY TO NUDGE THEM.
 *
 * A change stalls when a task waits for a team that has not noticed it. A
 * person who opens the task and is not in the responsible team cannot act,
 * but must see who can — the members of that team, the assignee marked — and
 * send each of them a reminder. Without a known team there is nobody to name,
 * and the panel stays out of the way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { inFlight, resetInFlight } from '@/test/apolloInFlight'
import { TeamGatePanel } from './TeamGatePanel'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))

const TEAM = { id: 't-db', name: 'SUP_Databases', members: [
  { id: 'u-anna', name: 'Anna Maria Rossi', email: 'anna@example.com' },
  { id: 'u-bo', name: 'bo', email: 'bo@example.com' },
] }

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetTeamDetail'] = { team: TEAM }
})

describe('TeamGatePanel', () => {
  it('names the responsible team and its members, the assignee marked', () => {
    renderWithProviders(<TeamGatePanel teamId="t-db" taskId="task-1" assigneeId="u-bo" />)
    expect(apolloFinto.chiamata('GetTeamDetail')).toEqual({ id: 't-db' })
    expect(screen.getByText('You are not in the team responsible for this task. You can nudge whoever has to act.')).toBeInTheDocument()
    expect(screen.getByText('SUP_Databases')).toBeInTheDocument()
    // Initials: at most two letters, capitalised.
    expect(screen.getByText('AM')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getAllByText('Assigned')).toHaveLength(1)
    expect(screen.getByText('bo').parentElement).toHaveTextContent('Assigned')
    expect(screen.getByText('Anna Maria Rossi').parentElement).not.toHaveTextContent('Assigned')
  })

  it('a nudge reaches that member for this task, and says it went', async () => {
    const { user } = renderWithProviders(<TeamGatePanel teamId="t-db" taskId="task-1" />)
    await user.click(screen.getAllByRole('button', { name: 'Nudge' })[0]!)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reminder sent'))
    expect(apolloFinto.chiamata('SendTaskReminder')).toEqual({ taskId: 'task-1', userId: 'u-anna' })
    expect(screen.queryByText('Assigned')).not.toBeInTheDocument()
  })

  it('a nudge that fails says why', async () => {
    apolloFinto.esiti['SendTaskReminder'] = { error: new Error('mail server down') }
    const { user } = renderWithProviders(<TeamGatePanel teamId="t-db" taskId="task-1" />)
    await user.click(screen.getAllByRole('button', { name: 'Nudge' })[1]!)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('mail server down'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('while a nudge is on its way no other can be sent', () => {
    inFlight.add('SendTaskReminder')
    renderWithProviders(<TeamGatePanel teamId="t-db" taskId="task-1" />)
    for (const button of screen.getAllByRole('button', { name: 'Nudge' })) expect(button).toBeDisabled()
  })

  it('without a responsible team, or with one that is gone, it shows nothing', () => {
    const { unmount } = renderWithProviders(<TeamGatePanel teamId={null} taskId="task-1" />)
    expect(apolloFinto.chiamate['GetTeamDetail']).toBeUndefined()
    expect(screen.queryByText(/not in the team responsible/)).not.toBeInTheDocument()
    unmount()
    apolloFinto.risposte['GetTeamDetail'] = { team: null }
    renderWithProviders(<TeamGatePanel teamId="t-gone" taskId="task-1" />)
    expect(apolloFinto.chiamata('GetTeamDetail')).toEqual({ id: 't-gone' })
    expect(screen.queryByText(/not in the team responsible/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Nudge' })).not.toBeInTheDocument()
  })
})
