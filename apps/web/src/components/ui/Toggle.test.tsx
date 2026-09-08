import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toggle } from './Toggle'

describe('Toggle', () => {
  it('è uno switch con nome accessibile e aria-checked', () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} label="Attivo" />)
    const sw = screen.getByRole('switch', { name: 'Attivo' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(sw).toHaveAttribute('type', 'button')
    expect(sw).toHaveAttribute('title', 'Attivo')
    rerender(<Toggle checked onChange={() => {}} label="Attivo" />)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveStyle({ background: 'var(--color-brand)' })
  })

  it('click → onChange con il valore invertito', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<Toggle checked={false} onChange={onChange} label="A" />)
    await user.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenLastCalledWith(true)
    rerender(<Toggle checked onChange={onChange} label="A" />)
    await user.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('tastiera: Space ed Enter attivano lo switch', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} label="A" />)
    screen.getByRole('switch').focus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledTimes(1)
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('disabled → nessun onChange, cursore not-allowed', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} label="A" disabled />)
    const sw = screen.getByRole('switch')
    expect(sw).toBeDisabled()
    expect(sw).toHaveStyle({ cursor: 'not-allowed' })
    await user.click(sw)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('size sm riduce la traccia (28×16) rispetto a md (36×20)', () => {
    render(<><Toggle checked={false} onChange={() => {}} label="S" size="sm" /><Toggle checked={false} onChange={() => {}} label="M" /></>)
    expect(screen.getByRole('switch', { name: 'S' })).toHaveStyle({ width: '28px', height: '16px' })
    expect(screen.getByRole('switch', { name: 'M' })).toHaveStyle({ width: '36px', height: '20px' })
  })
})
