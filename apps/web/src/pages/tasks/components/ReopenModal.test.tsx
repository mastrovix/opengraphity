/**
 * REOPENING A COMPLETED CHANGE TASK NEEDS A REASON.
 *
 * Reopening undoes work another team has signed off (an assessment, a plan,
 * a deployment): the reason is what they read in the change history to
 * understand why. So the dialog refuses to confirm until a real reason is
 * written (at least 10 characters, spaces do not count), sends it trimmed,
 * and every way out of it — Cancel, the close button, Escape — reopens
 * nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReopenModal } from './ReopenModal'

function setup() {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(<ReopenModal onConfirm={onConfirm} onCancel={onCancel} />)
  return { onConfirm, onCancel, user: userEvent.setup() }
}

describe('ReopenModal', () => {
  it('asks for the reason, and confirms only a real one, trimmed', async () => {
    const { onConfirm, user } = setup()
    const dialog = screen.getByRole('dialog', { name: 'Reopen task' })
    expect(dialog).toHaveTextContent('Enter the reason for reopening (min 10 characters).')
    const reason = screen.getByRole('textbox', { name: 'Reason for reopening...' })
    const confirm = screen.getByRole('button', { name: 'Confirm reopen' })
    expect(confirm).toBeDisabled()
    await user.type(reason, '   too short   ')
    expect(confirm).toBeDisabled()
    await user.clear(reason)
    await user.type(reason, '  Wrong CI assessed  ')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('Wrong CI assessed')
  })

  it('Cancel, the close button and Escape reopen nothing', async () => {
    const { onConfirm, onCancel, user } = setup()
    await user.type(screen.getByRole('textbox'), 'A good enough reason')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(3)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
