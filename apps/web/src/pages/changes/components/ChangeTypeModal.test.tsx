/**
 * THE CHANGE TYPE IS CHOSEN FIRST, IN A MODAL.
 *
 * Opening a new change starts here: the type decides whether the change skips
 * the approval chain and with what urgency it is handled. What a user relies
 * on, and what these tests pin:
 *  - the types offered are the customer's vocabulary, with their labels, and
 *    the page receives the VALUE of the one picked;
 *  - the explanation under a type exists only for the types the product ships
 *    (for a customer type we do not invent one), and a pre-approved type says
 *    so while choosing, not after;
 *  - while the types load, or when there are none, the modal says so and
 *    still has a way out; a stray click outside never closes it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n/i18n'
import { ChangeTypeModal, type ChangeTypeEntry } from './ChangeTypeModal'

const t = i18n.getFixedT('en')

const TYPES: ChangeTypeEntry[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'normal',   label: 'Normal' },
  { value: 'major',    label: 'Major works' },
]

function mount(props: Partial<React.ComponentProps<typeof ChangeTypeModal>> = {}) {
  const onPick = vi.fn()
  const onCancel = vi.fn()
  const user = userEvent.setup()
  render(<ChangeTypeModal open types={TYPES} preApproved={['standard']} onPick={onPick} onCancel={onCancel} {...props} />)
  return { user, onPick, onCancel, dialog: screen.getByRole('dialog', { name: 'What kind of change is this?' }) }
}

describe('ChangeTypeModal', () => {
  it('offers the customer types by label and hands the page the value of the one picked', async () => {
    const { user, onPick, dialog } = mount()
    expect(within(dialog).getByText(t('pages.createChange.pickTypeHelp'))).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /Major works/ }))
    expect(onPick).toHaveBeenCalledWith('major')
  })

  it('explains the shipped types only: a customer type gets no invented description', () => {
    const { dialog } = mount()
    expect(within(dialog).getByRole('button', { name: /^Standard/ })).toHaveTextContent(t('pages.createChange.typeHelp.standard'))
    expect(within(dialog).getByRole('button', { name: /^Normal/ })).toHaveTextContent(t('pages.createChange.typeHelp.normal'))
    expect(within(dialog).getByRole('button', { name: /Major works/ })).toHaveTextContent(/^Major works$/)
  })

  it('marks the pre-approved types while choosing', () => {
    const { dialog } = mount()
    expect(within(dialog).getByRole('button', { name: /^Standard/ })).toHaveTextContent('Pre-approved')
    expect(within(dialog).getByRole('button', { name: /^Normal/ })).not.toHaveTextContent('Pre-approved')
  })

  it('while the pre-approved types are unknown, no type is marked as pre-approved', () => {
    const { dialog } = mount({ preApproved: null })
    expect(within(dialog).queryByText('Pre-approved')).not.toBeInTheDocument()
  })

  it('while the types are loading it says so, and Cancel still leaves', async () => {
    const { user, onCancel, dialog } = mount({ types: null })
    expect(within(dialog).getByText('Loading...')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('with no type in the vocabulary it says where to add them, and is not a trap', async () => {
    const { user, onCancel, dialog } = mount({ types: [] })
    expect(within(dialog).getByText(t('pages.createChange.noChangeTypes'))).toBeInTheDocument()
    expect(within(dialog).queryByText('Loading...')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a click outside the panel does not close it: the type cannot be skipped by accident', async () => {
    const { user, onCancel, onPick, dialog } = mount()
    await user.click(dialog.parentElement!)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('the type under the pointer is highlighted, and the highlight goes away with the pointer', async () => {
    const { user, dialog } = mount()
    const normal = within(dialog).getByRole('button', { name: /^Normal/ })
    const restingBackground = normal.style.background
    await user.hover(normal)
    expect(normal.style.borderColor).toBe('var(--color-brand)')
    expect(normal.style.background).not.toBe(restingBackground)
    await user.unhover(normal)
    // Back to the plain border and background of the other options.
    expect(normal.style.borderColor).toBe('var(--color-border)')
    expect(normal.style.background).toBe(restingBackground)
  })

  it('closed, it shows nothing', () => {
    render(<ChangeTypeModal open={false} types={TYPES} preApproved={[]} onPick={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
