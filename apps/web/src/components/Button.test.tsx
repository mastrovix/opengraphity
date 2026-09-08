import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'

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
    ['primary',   { backgroundColor: 'var(--color-brand)', color: '#fff' }],
    ['secondary', { color: 'var(--color-slate)', background: '#fff' }],
    ['danger',    { color: 'var(--color-danger)' }],
    ['ghost',     { padding: '0px', background: 'none' }],
  ] as const)('variante %s', (variant, style) => {
    render(<Button variant={variant}>X</Button>)
    expect(screen.getByRole('button', { name: 'X' })).toHaveStyle(style)
  })

  it('size xs riduce il padding (6px 14px) rispetto a sm (8px 16px)', () => {
    render(<><Button size="xs">A</Button><Button size="sm">B</Button></>)
    expect(screen.getByRole('button', { name: 'A' })).toHaveStyle({ padding: '6px 14px' })
    expect(screen.getByRole('button', { name: 'B' })).toHaveStyle({ padding: '8px 16px' })
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
    expect(err).toHaveBeenCalledWith('[Button] variant="icon" richiede aria-label o title (nome accessibile)')
  })

  it('inoltra aria-expanded / aria-pressed e l\'icona precede il testo', () => {
    render(<Button aria-expanded={true} aria-pressed={false} icon={<span data-testid="ic">*</span>}>Testo</Button>)
    const btn = screen.getByRole('button', { name: '* Testo' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(btn.firstElementChild).toHaveAttribute('data-testid', 'ic')
  })

  it('style è un override puntuale che vince sulla variante', () => {
    render(<Button style={{ backgroundColor: 'rgb(1, 2, 3)', width: 200 }}>S</Button>)
    expect(screen.getByRole('button', { name: 'S' })).toHaveStyle({ backgroundColor: 'rgb(1, 2, 3)', width: '200px' })
  })
})
