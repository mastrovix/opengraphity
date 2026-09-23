/**
 * The centred modal of the form builder: the properties of a field or a
 * section, the new-field editor, the new-request form and the AI designer all
 * open in it.
 *
 * Why these behaviours matter:
 * - it is attached to the page body, not written where the builder renders
 *   it: inside the designer grid it inherited a height cap and came out cut;
 * - the title names the dialog for a screen reader, and the subtitle says
 *   WHAT is being edited (which section, which field) — an empty one is not
 *   drawn as a blank line;
 * - Escape and the close button are the ways out that change nothing, and
 *   Escape is heard on the document because the focus is usually in a text box;
 * - it is modal for the keyboard too: the focus goes inside when it opens,
 *   Tab does not walk out into the page behind, and the focus comes back
 *   where it was when it closes.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModaleCentrato } from './ModaleCentrato'

describe('ModaleCentrato', () => {
  it('is a modal dialog named by its title, on the page body, with the subtitle and the content', () => {
    const { container } = render(
      <section>
        <ModaleCentrato titolo="Field properties" sottotitolo="Cost centre" onChiudi={vi.fn()}>
          <label>Required <input type="checkbox" /></label>
        </ModaleCentrato>
      </section>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Field properties' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(container).not.toContainElement(dialog)
    expect(document.body).toContainElement(dialog)
    expect(within(dialog).getByText('Cost centre')).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'Required' })).toBeInTheDocument()
  })

  it('an empty or missing subtitle draws no subtitle', () => {
    const { rerender } = render(<ModaleCentrato titolo="Section properties" sottotitolo="" onChiudi={vi.fn()}><span>body</span></ModaleCentrato>)
    expect(within(screen.getByRole('dialog')).queryByRole('paragraph')).toBeNull()
    rerender(<ModaleCentrato titolo="Section properties" onChiudi={vi.fn()}><span>body</span></ModaleCentrato>)
    expect(within(screen.getByRole('dialog')).queryByRole('paragraph')).toBeNull()
  })

  it('the close button and Escape close it; other keys do not', async () => {
    const onClose = vi.fn()
    render(<ModaleCentrato titolo="New field" onChiudi={onClose}><input aria-label="Label" /></ModaleCentrato>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // Typing in a box of the dialog, Enter included, is not a way out.
    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Due date{Enter}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('once closed it stops listening to Escape', () => {
    const onClose = vi.fn()
    const { unmount } = render(<ModaleCentrato titolo="New field" onChiudi={onClose}><span>body</span></ModaleCentrato>)
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the dialog declared
   * `aria-modal="true"` but left the focus on the canvas behind the veil and
   * let Tab walk through the page, so the keyboard reached it last.
   */
  it('takes the focus when it opens, so the keyboard lands inside it', async () => {
    const user = userEvent.setup()
    // The canvas behind: the field just opened, and the next one.
    const canvas = <><button type="button">Requester</button><button type="button">Urgent</button></>
    const { rerender } = render(canvas)
    screen.getByRole('button', { name: 'Requester' }).focus()
    rerender(<>{canvas}<ModaleCentrato titolo="Field properties" onChiudi={vi.fn()}><input aria-label="Label" /></ModaleCentrato></>)
    await user.tab()
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
  })

  it('Tab and Shift+Tab stay inside it: after the last control comes the first, and back', async () => {
    const user = userEvent.setup()
    render(<>
      <button type="button">Requester</button>
      <ModaleCentrato titolo="Field properties" onChiudi={vi.fn()}><input aria-label="Label" /></ModaleCentrato>
      <button type="button">Urgent</button>
    </>)
    const close = screen.getByRole('button', { name: 'Cancel' })
    const label = screen.getByRole('textbox', { name: 'Label' })
    await waitFor(() => expect(close).toHaveFocus())
    await user.tab()
    expect(label).toHaveFocus()
    // The dialog is the last thing in the page: without the trap, Tab would go back to the canvas.
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab({ shift: true })
    expect(label).toHaveFocus()
  })

  it('closing it gives the focus back to what had it, so the keyboard goes on from there', async () => {
    // The same tree open and closed: the canvas button must be the same element throughout.
    const page = (open: boolean) => (
      <>
        <button type="button">Requester</button>
        {open && <ModaleCentrato titolo="Field properties" onChiudi={vi.fn()}><input aria-label="Label" /></ModaleCentrato>}
      </>
    )
    const { rerender } = render(page(false))
    const requester = screen.getByRole('button', { name: 'Requester' })
    requester.focus()
    rerender(page(true))
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement))
    rerender(page(false))
    expect(requester).toHaveFocus()
  })
})
