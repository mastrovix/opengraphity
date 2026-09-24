/**
 * The comment box with @-mentions (ticket comments, work notes).
 *
 * Why these behaviours matter: a mention is how a colleague gets NOTIFIED.
 * The inserted token `@[Name](id)` is what the API parses to find who to
 * notify, so a wrong format or a lost id means a silent comment nobody reads.
 * The suggestions must open only on a real mention (not inside an e-mail
 * address), be usable from the keyboard, and never eat the text around the
 * cursor. Ctrl+Enter is the "send" shortcut people rely on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apolloFinto } from '@/test/apolloFinto'
import { MentionInput } from './MentionInput'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const USERS = [
  { id: 'u1', name: 'Mario Rossi', email: 'mario@example.com' },
  { id: 'u2', name: 'Marta Bianchi', email: 'marta@example.com' },
  { id: 'u3', name: 'Luca Verdi', email: 'luca@example.com' },
]

function Harness({ initial = '', onSubmit, label, placeholder = 'Write a comment' }: {
  initial?: string; onSubmit?: () => void; label?: string; placeholder?: string
}) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <MentionInput value={value} onChange={setValue} onSubmit={onSubmit} label={label} placeholder={placeholder} />
      <output data-testid="value">{value}</output>
    </>
  )
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement
const valueNow = () => screen.getByTestId('value').textContent

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['SearchUsers'] = (vars?: Record<string, unknown>) => ({
    searchUsers: USERS.filter((u) => u.name.toLowerCase().startsWith(String(vars?.['search']).toLowerCase())),
  })
})

describe('MentionInput', () => {
  it('the accessible name is the label, or the placeholder when there is no label', () => {
    const { unmount } = render(<Harness label="Work note" />)
    expect(screen.getByRole('textbox', { name: 'Work note' })).toBeInTheDocument()
    unmount()
    render(<Harness />)
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toBeInTheDocument()
  })

  it('typing @ plus a name searches users (after the debounce) and lists them', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'Hi @mar')
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Mario Rossi (mario@example.com)', 'Marta Bianchi (marta@example.com)'])
    // The search sent is the text after the @, capped at five suggestions.
    expect(apolloFinto.chiamata('SearchUsers')).toEqual({ search: 'mar', limit: 5 })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('arrow keys move the highlight within bounds, Enter inserts the mention token', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'Hi @mar')
    await screen.findAllByRole('option')

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    // Clamped at the last suggestion, not past it.
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}{Enter}')

    // The exact token the API parses to notify the user.
    expect(valueNow()).toBe('Hi @[Marta Bianchi](u2) ')
    expect(screen.queryByRole('listbox')).toBeNull()
    await waitFor(() => { expect(box()).toHaveFocus() })
    // The field shows the name, not the token with the id (tour of 24 Sep 2026, G15).
    expect(box()).toHaveValue('Hi @Marta Bianchi ')
    expect(box().selectionStart).toBe('Hi @Marta Bianchi '.length)
  })

  it('writing after a mention keeps its token; editing the name turns it into plain text', async () => {
    const user = userEvent.setup()
    render(<Harness initial="Hi @[Marta Bianchi](u2) " />)
    expect(box()).toHaveValue('Hi @Marta Bianchi ')
    await user.type(box(), 'please check')
    expect(valueNow()).toBe('Hi @[Marta Bianchi](u2) please check')
    await user.clear(box())
    await user.type(box(), 'Hi @Marta Bianc')
    expect(valueNow()).toBe('Hi @Marta Bianc')
  })

  it('clicking a suggestion inserts it and keeps the text after the cursor', async () => {
    const user = userEvent.setup()
    render(<Harness initial=" see above" />)
    await user.type(box(), '@lu', { initialSelectionStart: 0, initialSelectionEnd: 0 })
    const option = await screen.findByRole('option', { name: /Luca Verdi/ })
    fireEvent.mouseDown(option)
    expect(valueNow()).toBe('@[Luca Verdi](u3)  see above')
  })

  it('Escape closes the suggestions without touching the text', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), '@mar')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(valueNow()).toBe('@mar')
  })

  it('a space after the name ends the mention', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), '@mar')
    await screen.findByRole('listbox')
    await user.type(box(), ' ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('an @ inside a word (an e-mail address) is not a mention', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'write to mario@mar')
    // Give the debounce time to fire: nothing must be searched.
    await new Promise((r) => setTimeout(r, 300))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(apolloFinto.chiamata('SearchUsers')).toBeUndefined()
  })

  it('Enter with no suggestion is a plain new line; Ctrl+Enter submits', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await user.type(box(), '@zz')
    await new Promise((r) => setTimeout(r, 300))
    await user.keyboard('{Enter}')
    expect(valueNow()).toBe('@zz\n')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('⌘+Enter submits too: on a Mac the shortcut is made with the command key (D13)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await user.type(box(), 'ready')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    // No new line was added by the shortcut.
    expect(valueNow()).toBe('ready')
  })

  it('Ctrl+Enter without an onSubmit handler does nothing harmful', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(box(), 'done')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(valueNow()).toBe('done')
  })
})
