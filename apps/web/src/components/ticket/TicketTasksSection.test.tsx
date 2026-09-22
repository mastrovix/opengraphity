/**
 * THE TASKS OF A TICKET, ON ITS PAGE.
 *
 * A workflow step creates team tasks ("prepare the laptop" for the Desk,
 * "create the account" for Systems) and the step WAITS until they are all
 * closed. This section is where people close or cancel them, so:
 *  - the count is the tasks still TO DO (open or waiting): it is what holds the
 *    step, and the answer to "how much is left?";
 *  - "Done" is not offered on a task that is waiting for another one — its turn
 *    has not come, and the server would refuse it;
 *  - a task without a team says so (the step's team was deleted: something to
 *    fix), instead of a harmless-looking dash;
 *  - cancelling needs a reason, and the reason is what reaches the server;
 *  - a failure is shown, and nothing pretends it worked;
 *  - no tasks at all → no section: most tickets never have any.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { formatDate } from '@/lib/datetime'
import type { TicketTaskRow } from './TicketTasksSection'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { TicketTasksSection } = await import('./TicketTasksSection')

const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

function task(over: Partial<TicketTaskRow> = {}): TicketTaskRow {
  return {
    id: 'k1', code: 'TSK-1', title: 'Prepare the laptop', description: null,
    state: 'open', afterTitle: null, entityType: 'service_request', entityId: 'e1', stepName: 'approved',
    dueAt: null, teamId: 't1', teamName: 'Desk', assigneeId: null, assigneeName: null,
    createdAt: '2026-09-20T08:00:00.000Z', completedAt: null, completedById: null, cancelReason: null,
    ...over,
  }
}

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset(); toast.error.mockReset()
})

const show = (tasks: TicketTaskRow[], titleKey?: string) => {
  apolloFinto.risposte['GetTicketTasks'] = { ticketTasks: tasks }
  return renderWithProviders(<TicketTasksSection entityId="e1" titleKey={titleKey} />)
}
const rowOf = (title: string) => screen.getByText(title).closest('li')!

describe('TicketTasksSection — what is shown', () => {
  it('renders nothing when the ticket has no tasks, and asks for the tasks of THIS ticket', () => {
    show([])
    expect(screen.queryByText(T('tasks.title'))).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('GetTicketTasks')).toEqual({ entityId: 'e1' })
  })

  it('renders nothing while the answer has not arrived', () => {
    renderWithProviders(<TicketTasksSection entityId="e1" />)
    expect(screen.queryByText(T('tasks.title'))).not.toBeInTheDocument()
  })

  it('counts only the tasks still to do, waiting ones included', () => {
    show([
      task({ id: 'a', title: 'A', state: 'open' }),
      task({ id: 'b', title: 'B', state: 'waiting', afterTitle: 'A' }),
      task({ id: 'c', title: 'C', state: 'completed' }),
      task({ id: 'd', title: 'D', state: 'cancelled', cancelReason: 'not needed' }),
    ])
    expect(screen.getByText(T('tasks.title')).parentElement).toHaveTextContent('2')
    // One icon per state, named for screen readers.
    expect(screen.getByLabelText(T('tasks.state.open'))).toBeInTheDocument()
    expect(screen.getByLabelText(T('tasks.state.waiting'))).toBeInTheDocument()
    expect(screen.getByLabelText(T('tasks.state.completed'))).toBeInTheDocument()
    expect(screen.getByLabelText(T('tasks.state.cancelled'))).toBeInTheDocument()
  })

  it('with everything closed there is no count, and closed tasks offer no action', () => {
    show([task({ state: 'completed' }), task({ id: 'k2', title: 'Other', state: 'cancelled' })])
    // Nothing left to do: a "0" badge would read as a count of something.
    expect(screen.getByText(T('tasks.title')).parentElement).toHaveTextContent(new RegExp(`^${T('tasks.title')}$`))
    expect(screen.queryByRole('button', { name: T('tasks.complete') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: T('tasks.cancel') })).not.toBeInTheDocument()
    expect(screen.getByText('Prepare the laptop')).toHaveStyle({ textDecoration: 'line-through' })
  })

  it('shows description, team, due date, what a waiting task waits for, and why a task was cancelled', () => {
    show([
      task({ id: 'a', description: 'Image it with the standard build', dueAt: '2026-09-25T10:00:00.000Z' }),
      task({ id: 'b', title: 'Create the account', state: 'waiting', afterTitle: 'Prepare the laptop', teamName: 'Systems' }),
      task({ id: 'c', title: 'Order a bag', state: 'cancelled', cancelReason: 'has one already' }),
    ])
    expect(screen.getByText('Image it with the standard build')).toBeInTheDocument()
    expect(within(rowOf('Prepare the laptop')).getByText(T('tasks.due', { date: formatDate('2026-09-25T10:00:00.000Z') }))).toBeInTheDocument()
    expect(within(rowOf('Create the account')).getByText(T('tasks.waitingFor', { title: 'Prepare the laptop' }))).toBeInTheDocument()
    expect(within(rowOf('Create the account')).getByText('Systems')).toBeInTheDocument()
    expect(screen.getByText(T('tasks.cancelledBecause', { reason: 'has one already' }))).toBeInTheDocument()
  })

  it('a task without a team says there is nobody to do it', () => {
    show([task({ teamName: null })])
    expect(within(rowOf('Prepare the laptop')).getByText(T('tasks.noTeam'))).toBeInTheDocument()
  })

  it('"Done" is not offered on a waiting task, "Cancel" is', () => {
    show([task({ state: 'waiting', afterTitle: 'Something else' })])
    expect(screen.queryByRole('button', { name: T('tasks.complete') })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: T('tasks.cancel') })).toBeInTheDocument()
  })

  it('uses the title key it is given (the change page names these differently)', () => {
    show([task()], 'common.description')
    expect(screen.getByText(T('common.description'))).toBeInTheDocument()
  })
})

describe('TicketTasksSection — closing a task', () => {
  it('"Done" completes that task, confirms it by code and reloads the list', async () => {
    const { user } = show([task()])
    await user.click(screen.getByRole('button', { name: T('tasks.complete') }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteTicketTask')).toEqual({ taskId: 'k1' }))
    expect(toast.success).toHaveBeenCalledWith(T('tasks.completed', { code: 'TSK-1' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a refused completion is shown and the list is not reloaded as if it had worked', async () => {
    apolloFinto.esiti['CompleteTicketTask'] = { error: new Error('Not your turn yet') }
    const { user } = show([task()])
    await user.click(screen.getByRole('button', { name: T('tasks.complete') }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Not your turn yet')))
    expect(toast.success).not.toHaveBeenCalled()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })
})

describe('TicketTasksSection — cancelling a task', () => {
  it('needs a reason, sends it, confirms and closes the dialog', async () => {
    const { user } = show([task()])
    await user.click(screen.getByRole('button', { name: T('tasks.cancel') }))
    expect(screen.getByText(T('tasks.cancelTitle', { code: 'TSK-1' }))).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: T('tasks.cancelConfirm') })
    expect(confirm).toBeDisabled()
    const reason = screen.getByPlaceholderText(T('tasks.cancelReasonPlaceholder'))
    // Blank is not a reason.
    await user.type(reason, '   ')
    expect(confirm).toBeDisabled()
    await user.type(reason, 'duplicate request')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(apolloFinto.chiamata('CancelTicketTask')).toEqual({ taskId: 'k1', reason: '   duplicate request' }))
    expect(toast.success).toHaveBeenCalledWith(T('tasks.cancelled', { code: 'TSK-1' }))
    await waitFor(() => expect(screen.queryByPlaceholderText(T('tasks.cancelReasonPlaceholder'))).not.toBeInTheDocument())
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('backing out of the dialog cancels nothing', async () => {
    const { user } = show([task()])
    await user.click(screen.getByRole('button', { name: T('tasks.cancel') }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: T('common.cancel') }))
    expect(screen.queryByPlaceholderText(T('tasks.cancelReasonPlaceholder'))).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('CancelTicketTask')).toBeUndefined()
  })

  it('Escape closes the dialog without cancelling the task', async () => {
    const { user } = show([task()])
    await user.click(screen.getByRole('button', { name: T('tasks.cancel') }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamata('CancelTicketTask')).toBeUndefined()
  })

  it('a refused cancellation is shown and the dialog stays open with the reason', async () => {
    apolloFinto.esiti['CancelTicketTask'] = { error: new Error('Already completed') }
    const { user } = show([task()])
    await user.click(screen.getByRole('button', { name: T('tasks.cancel') }))
    await user.type(screen.getByPlaceholderText(T('tasks.cancelReasonPlaceholder')), 'late')
    await user.click(screen.getByRole('button', { name: T('tasks.cancelConfirm') }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Already completed')))
    expect(screen.getByDisplayValue('late')).toBeInTheDocument()
  })
})
