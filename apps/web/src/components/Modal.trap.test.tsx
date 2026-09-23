/**
 * The focus trap of Modal, in the two cases the other Modal tests do not reach.
 *
 * A keyboard user must never Tab out of an open dialog into the page behind
 * it, and must never be pushed onto a control that is not visible. And inside
 * the dialog, Tab between two middle controls is the browser's job: the trap
 * steps in only at the edges (first/last), otherwise it would break ordinary
 * navigation through a form.
 *
 * jsdom has no layout: the global test setup makes every connected element
 * «visible» (`offsetParent` = its parent). Here one test makes the panel's
 * controls invisible, the way `display: none` does in a browser.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Modal } from './Modal'

/** The dialog moves the focus inside itself right after opening: wait for it, so the test starts from a settled state. */
const opened = () => waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())

const tab = (shiftKey = false) => {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  fireEvent(document, e)
  return e
}

describe('Modal focus trap (edges)', () => {
  it('Tab from a control in the middle of the panel is left to the browser', async () => {
    render(
      <Modal open onClose={() => {}} title="Edit" footer={<button type="button">Save</button>}>
        <input aria-label="Name" />
      </Modal>,
    )
    await opened()
    screen.getByRole('textbox', { name: 'Name' }).focus()
    expect(tab().defaultPrevented).toBe(false)
    expect(tab(true).defaultPrevented).toBe(false)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  })

  it('when no control of the panel is visible, Tab is swallowed and focus is not pushed onto a hidden control', async () => {
    render(<><button type="button">Page behind</button><Modal open onClose={() => {}} title="Edit"><input aria-label="Name" /></Modal></>)
    await opened()
    const dialog = screen.getByRole('dialog')
    const offsetParent = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockImplementation(function (this: HTMLElement) { return dialog.contains(this) ? null : this.parentElement })
    const behind = screen.getByRole('button', { name: 'Page behind' })
    behind.focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(behind).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus()
    offsetParent.mockRestore()
  })

  it('a hidden control that nonetheless has the focus still counts, so Tab from it wraps to the first control', async () => {
    render(
      <Modal open onClose={() => {}} title="Edit" footer={<button type="button">Save</button>}>
        <input aria-label="Name" />
      </Modal>,
    )
    await opened()
    const save = screen.getByRole('button', { name: 'Save' })
    const offsetParent = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockImplementation(function (this: HTMLElement) { return this === save ? null : this.parentElement })
    save.focus()
    expect(tab().defaultPrevented).toBe(true)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    offsetParent.mockRestore()
  })
})
