import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from './Modal'

function Body() {
  return (
    <>
      <input aria-label="first" />
      <button type="button">middle</button>
      <button type="button">last</button>
    </>
  )
}

describe('Modal', () => {
  it('open=false non renderizza nulla', () => {
    render(<Modal open={false} onClose={() => {}} title="T">x</Modal>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('è un dialog modale con nome accessibile = titolo e bottone di chiusura', () => {
    render(<Modal open onClose={() => {}} title="Nuovo utente"><Body /></Modal>)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Nuovo utente')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('sposta il focus dentro il pannello all\'apertura e lo restituisce alla chiusura', async () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open</button>
          <Modal open={open} onClose={() => setOpen(false)} title="T"><Body /></Modal>
        </>
      )
    }
    const user = userEvent.setup()
    render(<Host />)
    const opener = screen.getByText('open')
    opener.focus()
    await user.click(opener)
    // primo elemento focusabile del pannello: il bottone di chiusura nell'header
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('un elemento con autoFocus nel corpo tiene il focus (non viene scavalcato)', async () => {
    render(<Modal open onClose={() => {}} title="T"><input aria-label="auto" autoFocus /></Modal>)
    await waitFor(() => expect(screen.getByLabelText('auto')).toHaveFocus())
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByLabelText('auto')).toHaveFocus()
  })

  it('Escape chiama onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Modal open onClose={onClose} title="T"><Body /></Modal>)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('focus trap: Tab dall\'ultimo torna al primo, Shift+Tab dal primo va all\'ultimo', async () => {
    const user = userEvent.setup()
    render(<Modal open onClose={() => {}} title="T" footer={<button type="button">footer</button>}><Body /></Modal>)
    const first = screen.getByRole('button', { name: 'Close' })
    const last  = screen.getByRole('button', { name: 'footer' })

    last.focus()
    await user.tab()
    expect(first).toHaveFocus()

    await user.tab({ shift: true })
    expect(last).toHaveFocus()
  })

  it('Tab quando il focus è fuori dal pannello lo riporta al primo elemento', () => {
    render(<><button type="button">outside</button><Modal open onClose={() => {}} title="T"><Body /></Modal></>)
    screen.getByText('outside').focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  // L'overlay (sfondo scuro) è il genitore del pannello `role="dialog"`.
  const overlay = () => screen.getByRole('dialog').parentElement!

  it('click sull\'overlay chiude un dialog semplice; un click dentro il pannello no', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Modal open onClose={onClose} title="T"><Body /></Modal>)
    await user.click(screen.getByText('middle'))
    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(overlay())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('as="form": l\'overlay NON chiude (E-14), il pannello è un <form> e il submit passa da onSubmit', async () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    const user = userEvent.setup()
    render(
      <Modal open onClose={onClose} title="Form" as="form" onSubmit={onSubmit} footer={<button type="submit">Salva</button>}>
        <input aria-label="name" required />
      </Modal>,
    )
    await user.click(overlay())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').tagName).toBe('FORM')

    await user.type(screen.getByLabelText('name'), 'x')
    await user.click(screen.getByRole('button', { name: 'Salva' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('closeOnOverlay forza il comportamento in entrambe le direzioni', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Modal open onClose={onClose} title="T" as="form" closeOnOverlay><Body /></Modal>)
    await user.click(overlay())
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<Modal open onClose={onClose} title="T" closeOnOverlay={false}><Body /></Modal>)
    await user.click(overlay())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('footer opzionale e larghezza personalizzabile', () => {
    const { rerender } = render(<Modal open onClose={() => {}} title="T" width={640}><Body /></Modal>)
    expect(screen.getByRole('dialog')).toHaveStyle({ width: '640px' })
    expect(screen.queryByText('ok')).not.toBeInTheDocument()
    rerender(<Modal open onClose={() => {}} title="T" footer={<span>ok</span>}><Body /></Modal>)
    expect(screen.getByText('ok')).toBeInTheDocument()
  })
})
