/**
 * Extra Modal behaviours not pinned by Modal.test.tsx: the close button gives
 * hover feedback (it is a bare icon, the colour change is the only hint it is
 * clickable), a click inside the panel never bubbles to the row/card that
 * mounted the modal, and a Tab pressed while the focus is on the page behind
 * is taken over by the dialog, not left to the browser.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from './Modal'

describe('Modal (more)', () => {
  it('the close button darkens on hover and goes back on leave', async () => {
    const user = userEvent.setup()
    render(<Modal open onClose={() => {}} title="T">body</Modal>)
    const close = screen.getByRole('button', { name: 'Close' })
    const idle = close.style.color
    await user.hover(close)
    expect(close.style.color).toBe('var(--color-slate)')
    await user.unhover(close)
    expect(close.style.color).toBe(idle)
  })

  it('a click on the overlay does not reach the React parent that mounted the modal', async () => {
    const user = userEvent.setup()
    const parentClick = vi.fn()
    const onClose = vi.fn()
    render(
      <div onClick={parentClick}>
        <Modal open onClose={onClose} title="T"><p>inside</p></Modal>
      </div>,
    )
    await user.click(screen.getByText('inside'))
    // The portal moves the DOM but not the React tree: without stopPropagation
    // this click would open the row behind the dialog.
    expect(parentClick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Tab from the page behind is taken over: the focus goes to the dialog, and the browser does not move it further', () => {
    render(<><button type="button">outside</button><Modal open onClose={() => {}} title="T">body</Modal></>)
    const outside = screen.getByRole('button', { name: 'outside' })
    // The global setup makes every connected element count as visible, so the
    // panel's close button IS focusable here: the trap puts the focus on it
    // and cancels the key, otherwise the browser would then move it one step
    // on. The case where nothing in the panel is visible is Modal.trap.test.tsx.
    outside.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    fireEvent(document, tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('other keys are left alone', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="T">body</Modal>)
    const key = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    fireEvent(document, key)
    expect(key.defaultPrevented).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })
})
