/**
 * THE SMALL PIECES EVERY CHANGE PANEL IS BUILT FROM.
 *
 * Each task row, dialog and "open task" link of the change detail page comes
 * from here, so a regression shows up on every panel at once:
 *  - a task row must say WHEN a scheduled task will start instead of showing
 *    a bare "to be completed" (a planner reads that as overdue), who closed a
 *    completed one, and who owns an open one;
 *  - task results are shown in the reader's language, and an unknown result is
 *    shown as it is rather than hidden;
 *  - the dialog closes with Escape, with its close button and with a click on
 *    the backdrop — but NOT with a click inside the panel;
 *  - the "open"/"view" buttons inside a clickable row must not also trigger the row.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import { formatDateTime } from '@/lib/datetime'
import {
  OpenTaskButton, EyeButton, ModalOverlay, taskResultLabel, TaskStatusRow, DetailField, DescriptionField,
} from './shared'

const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

describe('OpenTaskButton', () => {
  it('links to the task and does not let the click reach the row around it', async () => {
    const rowClick = vi.fn()
    const { user } = renderWithProviders(
      <div onClick={rowClick}><OpenTaskButton taskId="t-42" /></div>,
    )
    const link = screen.getByRole('link', { name: T('common.open') })
    expect(link).toHaveAttribute('href', '/tasks/t-42')
    await user.click(link)
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tasks/t-42'))
    expect(rowClick).not.toHaveBeenCalled()
  })
})

describe('EyeButton', () => {
  it('calls its handler and not the row handler', async () => {
    const rowClick = vi.fn(); const onClick = vi.fn()
    const { user } = renderWithProviders(
      <div onClick={rowClick}><EyeButton onClick={onClick} /></div>,
    )
    await user.click(screen.getByRole('button', { name: T('common.view') }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
  })
})

describe('ModalOverlay', () => {
  const renderModal = () => {
    const onClose = vi.fn()
    const r = renderWithProviders(
      <ModalOverlay title="Task detail" onClose={onClose}><p>Body text</p><input aria-label="inner" /></ModalOverlay>,
    )
    return { ...r, onClose }
  }

  it('is a named modal dialog and moves the focus into it (keyboard users start inside)', async () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: 'Task detail' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: 'Task detail' })).toBeInTheDocument()
    // The first focusable element is the close button.
    await waitFor(() => expect(screen.getByRole('button', { name: T('common.close') })).toHaveFocus())
  })

  it('closes with Escape, and other keys do nothing', async () => {
    const { user, onClose } = renderModal()
    // (Not Enter: the focus is on the close button, where Enter is a click.)
    await user.keyboard('a')
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes with its button and with a click on the backdrop, not with a click inside', async () => {
    const { user, onClose } = renderModal()
    await user.click(screen.getByText('Body text'))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: T('common.close') }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('stops listening to Escape once closed', async () => {
    const { user, onClose, unmount } = renderModal()
    unmount()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('taskResultLabel', () => {
  const t = i18n.t.bind(i18n)
  it('translates the four known results', () => {
    expect(taskResultLabel(t, 'pass')).toBe(T('taskStatus.result.pass'))
    expect(taskResultLabel(t, 'fail')).toBe(T('taskStatus.result.fail'))
    expect(taskResultLabel(t, 'confirmed')).toBe(T('taskStatus.result.confirmed'))
    expect(taskResultLabel(t, 'rejected')).toBe(T('taskStatus.result.rejected'))
    // Not the raw key: a missing translation would show "taskStatus.result.pass".
    expect(taskResultLabel(t, 'pass')).not.toContain('taskStatus.')
  })
  it('shows an unknown result as it is rather than hiding it', () => {
    expect(taskResultLabel(t, 'partial')).toBe('partial')
  })
})

describe('TaskStatusRow', () => {
  it('a pending task scheduled in the future says when it starts, and hides status and result', () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
    renderWithProviders(<TaskStatusRow label="Deploy" code="TSK-1" status="pending" scheduledDate={future} result="pass" />)
    expect(screen.getByText(T('changeTasks.scheduledOn', { date: formatDateTime(future) }))).toBeInTheDocument()
    expect(screen.queryByText(T('taskStatus.toBeCompleted'))).not.toBeInTheDocument()
    expect(screen.queryByText(new RegExp(T('taskStatus.result.pass')))).not.toBeInTheDocument()
    expect(screen.getByText('TSK-1')).toBeInTheDocument()
  })

  it('a pending task whose date has passed shows its status, not a date in the past', () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    renderWithProviders(<TaskStatusRow label="Deploy" status="pending" scheduledDate={past} />)
    expect(screen.getByText(T('taskStatus.toBeCompleted'))).toBeInTheDocument()
    expect(screen.queryByText(T('changeTasks.scheduledOn', { date: formatDateTime(past) }))).not.toBeInTheDocument()
  })

  it('a completed task shows the result, who closed it and when', () => {
    const when = '2026-09-10T10:00:00.000Z'
    renderWithProviders(<TaskStatusRow label="Review" status="completed" result="confirmed" actor="Ada" date={when} assignedTeam="Ops" action={<button type="button">act</button>} />)
    expect(screen.getByText(`· ${T('taskStatus.result.confirmed')}`)).toBeInTheDocument()
    expect(screen.getByText(`Ada · ${formatDateTime(when)}`)).toBeInTheDocument()
    // The owner line is for open tasks only.
    expect(screen.queryByText('Ops')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'act' })).toBeInTheDocument()
  })

  it('a completed task with only the actor, or only the date, shows just that', () => {
    const when = '2026-09-10T10:00:00.000Z'
    const { unmount } = renderWithProviders(<TaskStatusRow label="Review" status="completed" actor="Ada" />)
    expect(screen.getByText('Ada')).toBeInTheDocument()
    unmount()
    renderWithProviders(<TaskStatusRow label="Review" status="completed" date={when} />)
    expect(screen.getByText(formatDateTime(when))).toBeInTheDocument()
  })

  it('an open task shows its team and, when there is one, the assignee', () => {
    const { unmount } = renderWithProviders(<TaskStatusRow label="Build" status="in-progress" assignedTeam="Ops" assignee="Bob" />)
    expect(screen.getByText('Ops')).toBeInTheDocument()
    expect(screen.getByText('Ops').parentElement).toHaveTextContent(`${T('detail.assignedTo')}: Ops — Bob`)
    unmount()
    renderWithProviders(<TaskStatusRow label="Build" status="in-progress" assignedTeam="Ops" />)
    expect(screen.getByText('Ops').parentElement).not.toHaveTextContent('—')
  })

  it('without a status shows a dash instead of an empty cell', () => {
    renderWithProviders(<TaskStatusRow label="Build" status={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('DetailField', () => {
  it('shows label and value', () => {
    renderWithProviders(<DetailField label="Risk" value="High" />)
    expect(screen.getByText('Risk')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
  })
})

describe('DescriptionField', () => {
  it('a short description has no "show all" toggle and uses the default label', () => {
    renderWithProviders(<DescriptionField value="Short text" />)
    expect(screen.getByText(T('common.description'))).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('a long description is clamped and can be expanded and collapsed again', async () => {
    const long = 'x'.repeat(151)
    const user = userEvent.setup()
    renderWithProviders(<DescriptionField value={long} label="Plan" />)
    expect(screen.getByText('Plan')).toBeInTheDocument()
    const text = screen.getByText(long)
    expect(text.style.overflow).toBe('hidden')
    await user.click(screen.getByRole('button', { name: T('common.showAll') }))
    expect(text.style.overflow).toBe('')
    await user.click(screen.getByRole('button', { name: T('common.showLess') }))
    expect(text.style.overflow).toBe('hidden')
  })
})
