/**
 * UNA RISPOSTA NELLA CONVERSAZIONE, e cosa l'autore ci può fare (ondata 6).
 *
 * L'autore corregge o cancella la PROPRIA risposta, e resta la traccia: un
 * messaggio cancellato non sparisce, dice chi l'ha tolto e quando. In una
 * conversazione con l'assistenza, un buco senza spiegazione e' peggio della
 * riga cancellata.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommentBubble } from './CommentBubble'

afterEach(cleanup)

const props = (over: Record<string, unknown> = {}) => ({
  body: 'Ho un problema con la stampante',
  authorName: 'Mario Rossi', authorEmail: 'mario@acme.example',
  createdAt: '2026-09-08T08:10:00Z', isOwn: true,
  ...over,
})

describe('CommentBubble', () => {
  it('mostra autore, data e testo', () => {
    render(<CommentBubble {...props()} />)
    expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument()
    expect(screen.getByText('Ho un problema con la stampante')).toBeInTheDocument()
  })

  it('una risposta senza autore si attribuisce all\'assistenza, non a nessuno', () => {
    render(<CommentBubble {...props({ authorName: '', isOwn: false })} />)
    expect(screen.queryByText(/^ · /)).toBeNull()
    expect(screen.getByText(/·/)).toBeInTheDocument()
  })

  it('modifica e cancellazione si offrono solo sulla PROPRIA risposta, e solo se il chiamante le gestisce', () => {
    render(<CommentBubble {...props({ isOwn: false })} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    render(<CommentBubble {...props()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('correggere sostituisce il testo e chiude la casella', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(<CommentBubble {...props()} onEdit={onEdit} onDelete={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /edit/i }))
    const box = screen.getByRole('textbox')
    await user.clear(box)
    await user.type(box, 'Corretto')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onEdit).toHaveBeenCalledWith('Corretto')
    await vi.waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull() })
  })

  it('una correzione vuota non si può salvare: sarebbe una cancellazione mascherata', async () => {
    const user = userEvent.setup()
    render(<CommentBubble {...props()} onEdit={vi.fn()} onDelete={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /edit/i }))
    await user.clear(screen.getByRole('textbox'))
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('annullare la correzione lascia il testo com\'era', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(<CommentBubble {...props()} onEdit={onEdit} onDelete={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /edit/i }))
    await user.type(screen.getByRole('textbox'), '!!!')
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('Ho un problema con la stampante')).toBeInTheDocument()
  })

  it('cancellare CHIEDE conferma: e\' un dialogo, e si può dire di no', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<CommentBubble {...props()} onEdit={vi.fn()} onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: /delete/i }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onDelete).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /delete/i }))
    await user.click(screen.getAllByRole('button', { name: /delete/i }).at(-1)!)
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('una risposta CANCELLATA resta, e dice chi l\'ha tolta e quando', () => {
    // Un buco senza spiegazione, in una conversazione con l'assistenza, e'
    // peggio della riga cancellata.
    render(<CommentBubble {...props({ deletedAt: '2026-09-08T09:00:00Z', deletedByName: 'Mario Rossi' })} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.queryByText('Ho un problema con la stampante')).toBeNull()
    // Il nome compare due volte: come autore e come chi l'ha cancellata.
    expect(screen.getAllByText(/Mario Rossi/).length).toBeGreaterThan(1)
    expect(screen.queryByRole('button')).toBeNull()   // niente da correggere
  })

  it('una risposta CORRETTA lo dice, con chi e quando', () => {
    render(<CommentBubble {...props({ editedAt: '2026-09-08T09:00:00Z', editedByName: 'Mario Rossi' })} />)
    expect(screen.getByText('Ho un problema con la stampante')).toBeInTheDocument()
    expect(screen.getByText(/edited|modificat/i)).toBeInTheDocument()
  })
})
