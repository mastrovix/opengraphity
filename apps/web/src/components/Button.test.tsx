import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'
/*
 * IL NOME ACCESSIBILE HA PERSO UNO SPAZIO (21 set 2026, jsdom 30).
 *
 * jsdom 30 non inserisce piu' uno spazio fra elementi IN LINEA quando calcola
 * il nome accessibile: «* Testo» e' diventato «*Testo». Il DOM che il prodotto
 * rende non e' cambiato di una virgola — e' cambiato il modo in cui la
 * libreria di prova lo legge, e la 30 e' piu' vicina alla specifica accname.
 *
 * Si aggiorna l'atteso invece di allentare la ricerca con una regex: il punto
 * di queste asserzioni e' proprio che il nome accessibile sia ESATTAMENTE
 * quello, perche' e' quello che un lettore di schermo annuncia.
 */

describe('Button', () => {
  it('type è "button" di default (non submitta un form per sbaglio) e rispetta type="submit"', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button>Plain</Button>
        <Button type="submit">Send</Button>
      </form>,
    )
    expect(screen.getByRole('button', { name: 'Plain' })).toHaveAttribute('type', 'button')
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit')
  })

  it('click su type=button non invia il form, su submit sì', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button>Plain</Button>
        <Button type="submit">Send</Button>
      </form>,
    )
    await user.click(screen.getByRole('button', { name: 'Plain' }))
    expect(onSubmit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('onClick viene chiamato; disabled blocca il click e cambia cursore/opacità', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const { rerender } = render(<Button onClick={onClick}>Go</Button>)
    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(<Button onClick={onClick} disabled>Go</Button>)
    const btn = screen.getByRole('button', { name: 'Go' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveStyle({ cursor: 'not-allowed', opacity: '0.6' })
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['primary',   { backgroundColor: 'var(--color-brand)', color: 'var(--color-white)' }],
    ['secondary', { color: 'var(--color-slate)', background: 'var(--color-white)' }],
    ['danger',    { color: 'var(--color-danger)' }],
    ['ghost',     { padding: '0px', background: 'none' }],
  ] as const)('variante %s', (variant, style) => {
    render(<Button variant={variant}>X</Button>)
    expect(screen.getByRole('button', { name: 'X' })).toHaveStyle(style)
  })

  // 26 Sep 2026: a size smaller — the buttons were 36-38 px tall with 12-13 px text.
  it('size xs riduce il padding (4px 12px) rispetto a sm (6px 14px)', () => {
    render(<><Button size="xs">A</Button><Button size="sm">B</Button></>)
    expect(screen.getByRole('button', { name: 'A' })).toHaveStyle({ padding: '4px 12px' })
    expect(screen.getByRole('button', { name: 'B' })).toHaveStyle({ padding: '6px 14px' })
  })

  it('icon: aria-label esplicito, altrimenti title come nome accessibile', () => {
    render(
      <>
        <Button variant="icon" aria-label="Chiudi" icon={<svg data-testid="i1" />} />
        <Button variant="icon" title="Apri" icon={<svg data-testid="i2" />} />
      </>,
    )
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument()
    const byTitle = screen.getByRole('button', { name: 'Apri' })
    expect(byTitle).toHaveAttribute('aria-label', 'Apri')
    expect(byTitle).toHaveAttribute('title', 'Apri')
  })

  it('icon senza nome accessibile → console.error in dev (fail-visible, non silenzioso)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Button variant="icon" icon={<svg />} />)
    expect(err).toHaveBeenCalledWith('[Button] variant="icon" needs aria-label or title (an accessible name)')
  })

  it('inoltra aria-expanded / aria-pressed e l\'icona precede il testo', () => {
    render(<Button aria-expanded={true} aria-pressed={false} icon={<span data-testid="ic">*</span>}>Testo</Button>)
    const btn = screen.getByRole('button', { name: '*Testo' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(btn.firstElementChild).toHaveAttribute('data-testid', 'ic')
  })

  it('style è un override puntuale che vince sulla variante', () => {
    render(<Button style={{ backgroundColor: 'rgb(1, 2, 3)', width: 200 }}>S</Button>)
    expect(screen.getByRole('button', { name: 'S' })).toHaveStyle({ backgroundColor: 'rgb(1, 2, 3)', width: '200px' })
  })
})

/*
 * Review of 23 Sep 2026: a double click on «Create» made two SLA policies,
 * two triggers, two channels. The rule lives in the button, once.
 */
describe('Button — an action in flight is not started twice', () => {
  it('a returned promise disables the button until it settles; a second click in between does nothing', async () => {
    let finish!: () => void
    const onClick = vi.fn(() => new Promise<void>((r) => { finish = r }))
    render(<Button onClick={onClick}>Create</Button>)
    const btn = screen.getByRole('button', { name: 'Create' })
    const user = userEvent.setup()
    await user.dblClick(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
    await act(async () => { finish() })
    expect(btn).toBeEnabled()
    expect(btn).not.toHaveAttribute('aria-busy')
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('a failed action frees the button too, and its error is written, not swallowed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('server said no')
    const onClick = vi.fn(() => Promise.reject(failure))
    render(<Button onClick={onClick}>Save</Button>)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    expect(err).toHaveBeenCalledWith('[Button] the action failed', failure)
  })

  it('a handler that returns nothing keeps the button as it was', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Open</Button>)
    await userEvent.setup().dblClick(screen.getByRole('button', { name: 'Open' }))
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled()
  })
})
