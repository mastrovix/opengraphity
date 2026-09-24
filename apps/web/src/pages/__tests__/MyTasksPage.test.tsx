/**
 * «MY TASKS»: picking up a task, and the page states around the list.
 *
 * `mieiCompiti.test.tsx` covers where each row leads. This file covers what a
 * person DOES here, and what breaks for them if it regresses:
 *  - «Take it» calls the right mutation for the right kind of task: change
 *    tasks and generic ticket tasks are two different nodes on the server;
 *  - «Take it» is offered on a generic task only to whoever may WRITE that
 *    kind of ticket: the server refuses the others, so offering the button
 *    was a promise followed by an error;
 *  - a change task cannot be claimed while the current user is unknown, and
 *    the page says so instead of sending a claim for nobody;
 *  - an empty list, a failed load and the counts in the subtitle are what
 *    tell the person whether there is work waiting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { MyTasksPage } = await import('../MyTasksPage')

interface Row {
  id: string; code: string; kind: string; role: string; action: string; status: string
  entityType: string; entityId: string; entityNumber: string
  ciId: string | null; ciName: string | null; phase: string; createdAt: string
}

const task = (over: Partial<Row> = {}): Row => ({
  id: 't1', code: 'TASK00000001', kind: 'task', role: '', action: 'Prepare the machine', status: 'open',
  entityType: 'incident', entityId: 'inc-1', entityNumber: 'INC00000001',
  ciId: null, ciName: null, phase: 'in_progress', createdAt: '2026-09-20T10:00:00Z', ...over,
})

const serve = (assignedToMe: Row[], unassigned: Row[] = []) => {
  apolloFinto.risposte['GetMyTasks'] = { myTasks: { assignedToMe, unassigned } }
}

const me = (permissions: string[] | null) => {
  apolloFinto.risposte['GetMe'] = permissions === null ? { me: null } : {
    me: { id: 'u-7', name: 'Ann', email: 'ann@acme.com', role: 'operator', roleName: null, permissions, slackId: null, emailNotifications: null, language: null, teams: [] },
  }
}

const takeIt = () => screen.getAllByRole('button', { name: 'Take it' })

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  me(['incident.write'])
})

describe('MyTasksPage — states of the page', () => {
  it('nothing to do: the empty state, and the count says zero', () => {
    serve([])
    renderWithProviders(<MyTasksPage />)
    expect(screen.getByText('No task for you')).toBeInTheDocument()
    expect(screen.getByText('0 tasks (0 assigned to you · 0 to pick up)')).toBeInTheDocument()
  })

  it('a failed load shows the error, and retry reloads', async () => {
    apolloFinto.erroriQuery['GetMyTasks'] = new Error('graph unavailable')
    const { user } = renderWithProviders(<MyTasksPage />)
    expect(screen.getByText(/graph unavailable/)).toBeInTheDocument()
    // No empty state on top of an error: «no task» would be a lie.
    expect(screen.queryByText('No task for you')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('tickets are grouped, newest number first, and the header links to the ticket', () => {
    serve([
      task({ id: 'a', entityNumber: 'INC00000001', entityId: 'inc-1' }),
      task({ id: 'b', entityNumber: 'INC00000009', entityId: 'inc-9', code: 'TASK00000009' }),
      task({ id: 'c', entityNumber: 'INC00000001', entityId: 'inc-1', code: 'TASK00000003' }),
    ])
    renderWithProviders(<MyTasksPage />)
    expect(screen.getByText('3 tasks (3 assigned to you · 0 to pick up)')).toBeInTheDocument()
    const headers = screen.getAllByRole('link', { name: /^INC/ })
    expect(headers.map((h) => h.textContent)).toEqual(['INC00000009', 'INC00000001'])
    expect(headers[1]).toHaveAttribute('href', '/incidents/inc-1')
    // Assigned tasks are already mine: nothing to take.
    expect(screen.queryByRole('button', { name: 'Take it' })).not.toBeInTheDocument()
  })

  it('a ticket of a kind with no page: the header is plain text and the row stays on this page', () => {
    serve([task({ entityType: 'mystery', entityNumber: 'MYS-1' })])
    renderWithProviders(<MyTasksPage />)
    expect(screen.queryByRole('link', { name: 'MYS-1' })).not.toBeInTheDocument()
    expect(screen.getByText('MYS-1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Task' })).toHaveAttribute('href', '/my-tasks')
  })

  it('change tasks read their kind and role in the reader language', () => {
    serve([
      task({ id: 's', kind: 'assessment', role: 'support', status: 'in-progress', entityType: 'change', entityNumber: 'CHG1' }),
      task({ id: 'p', kind: 'deploy-plan', status: 'in_progress', entityType: 'change', entityNumber: 'CHG2' }),
    ])
    renderWithProviders(<MyTasksPage />)
    expect(screen.getByRole('link', { name: 'Technical assessment' })).toHaveAttribute('href', '/tasks/s')
    expect(screen.getByText('Fill in the Technical assessment')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Deployment plan' })).toHaveAttribute('href', '/tasks/p')
    expect(screen.getAllByText('in progress')).toHaveLength(2)
  })
})

describe('MyTasksPage — «Take it»', () => {
  it('a generic task is claimed with its own mutation, and the list reloads', async () => {
    serve([], [task({ id: 'gen-1' })])
    const { user } = renderWithProviders(<MyTasksPage />)
    expect(screen.getByText('1 tasks (0 assigned to you · 1 to pick up)')).toBeInTheDocument()
    await user.click(takeIt()[0]!)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Task claimed'))
    expect(apolloFinto.chiamata('ClaimTicketTask')).toEqual({ taskId: 'gen-1' })
    expect(apolloFinto.chiamate['AssignAssessmentTaskToUser']).toBeUndefined()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a change assessment is claimed for the current user', async () => {
    serve([], [task({ id: 'as-1', kind: 'assessment', role: 'owner', status: 'pending', entityType: 'change', entityNumber: 'CHG9' })])
    const { user } = renderWithProviders(<MyTasksPage />)
    await user.click(takeIt()[0]!)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Task claimed'))
    expect(apolloFinto.chiamata('AssignAssessmentTaskToUser')).toEqual({ taskId: 'as-1', userId: 'u-7' })
  })

  // Review of 23 Sep 2026: this test pinned the assessment mutation for a deploy plan, which the API answers NotFound.
  it('a deploy plan is claimed with its own mutation', async () => {
    serve([], [task({ id: 'dp-1', kind: 'deploy-plan', status: 'pending', entityType: 'change', entityNumber: 'CHG9' })])
    const { user } = renderWithProviders(<MyTasksPage />)
    await user.click(takeIt()[0]!)
    await waitFor(() => expect(apolloFinto.chiamata('AssignDeployPlanTaskToUser')).toEqual({ taskId: 'dp-1', userId: 'u-7' }))
    expect(apolloFinto.chiamata('AssignAssessmentTaskToUser')).toBeUndefined()
  })

  it('while the current user is unknown, a change task is not claimed for nobody', async () => {
    me(null)
    serve([], [task({ id: 'as-2', kind: 'assessment', role: 'owner', status: 'pending', entityType: 'change', entityNumber: 'CHG9' })])
    const { user } = renderWithProviders(<MyTasksPage />)
    await user.click(takeIt()[0]!)
    expect(toast.error).toHaveBeenCalledWith('User not identified')
    expect(apolloFinto.chiamate['AssignAssessmentTaskToUser']).toBeUndefined()
  })

  it('a refused claim is reported and nothing is announced', async () => {
    apolloFinto.esiti['ClaimTicketTask'] = { error: new Error('already taken') }
    serve([], [task()])
    const { user } = renderWithProviders(<MyTasksPage />)
    await user.click(takeIt()[0]!)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('already taken'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a refused assessment claim is reported too', async () => {
    apolloFinto.esiti['AssignAssessmentTaskToUser'] = { error: new Error('not in the team') }
    serve([], [task({ kind: 'assessment', role: 'owner', status: 'pending', entityType: 'change', entityNumber: 'CHG9' })])
    const { user } = renderWithProviders(<MyTasksPage />)
    await user.click(takeIt()[0]!)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not in the team'))
  })

  it('«Take it» is offered only where the person may write the ticket, and never on other change tasks', () => {
    me(['incident.write'])
    serve([], [
      task({ id: 'i', entityType: 'incident', entityNumber: 'INC5' }),
      task({ id: 'p', entityType: 'problem', entityNumber: 'PRB5', entityId: 'prb-5' }),
      task({ id: 'x', entityType: 'mystery', entityNumber: 'MYS5' }),
      task({ id: 'v', kind: 'validation', status: 'pending', entityType: 'change', entityNumber: 'CHG5' }),
    ])
    renderWithProviders(<MyTasksPage />)
    const buttons = takeIt()
    expect(buttons).toHaveLength(1)
    // The one button is on the incident task, the only ticket this role may write.
    const incidentGroup = screen.getByRole('link', { name: 'INC5' }).parentElement!.parentElement!
    expect(within(incidentGroup).getByRole('button', { name: 'Take it' })).toBe(buttons[0])
  })
})
