/**
 * DetailField is the label/value pair of every detail card, and with
 * `editable` the inline editor of free-text fields (e.g. a description).
 * What breaks for a user if it regresses: an empty field that shows nothing
 * instead of the dash, an edit that starts from an empty box instead of the
 * current text, or a Cancel that still saves.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DetailField } from './DetailField'

describe('DetailField', () => {
  it('shows the value, and a dash when there is none', () => {
    const { rerender } = render(<DetailField label="Owner" value="Ann" />)
    expect(screen.getByText('Ann')).toBeInTheDocument()
    rerender(<DetailField label="Owner" value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    // Not editable: no edit button.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('uses the monospace token for ids', () => {
    render(<DetailField label="ID" value="abc-123" mono />)
    expect(screen.getByText('abc-123')).toHaveStyle({ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' })
  })

  it('edits starting from the current text and saves the draft', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<DetailField label="Description" value="old text" editable onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: /Description/ }))
    const box = screen.getByRole('textbox', { name: 'Description' })
    expect(box).toHaveValue('old text')
    expect(box).toHaveFocus()
    await user.clear(box)
    await user.type(box, 'new text')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith('new text')
    // Back to read mode after saving.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('starts from an empty box when the value is not plain text, and Cancel discards', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<DetailField label="Notes" value={<em>rich</em>} editable onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: /Notes/ }))
    // A React node cannot be edited as text: the draft starts empty rather than "[object Object]".
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('')
    await user.type(screen.getByRole('textbox'), 'x')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('rich')).toBeInTheDocument()
  })

  it('saving without an onSave handler just closes the editor', async () => {
    const user = userEvent.setup()
    render(<DetailField label="Notes" value="a" editable />)
    await user.click(screen.getByRole('button', { name: /Notes/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
