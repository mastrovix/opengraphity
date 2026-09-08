import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SectionCard } from './SectionCard'

describe('SectionCard', () => {
  it('chiusa di default: bottone aria-expanded=false, contenuto non montato', () => {
    render(<SectionCard title="Info"><p>corpo</p></SectionCard>)
    const btn = screen.getByRole('button', { name: 'Info' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(btn).toHaveAttribute('aria-controls')
    expect(screen.queryByText('corpo')).not.toBeInTheDocument()
  })

  it('click apre: aria-expanded=true e il pannello ha l\'id di aria-controls', async () => {
    const user = userEvent.setup()
    render(<SectionCard title="Info"><p>corpo</p></SectionCard>)
    const btn = screen.getByRole('button', { name: 'Info' })
    await user.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById(btn.getAttribute('aria-controls')!)
    expect(panel).not.toBeNull()
    expect(panel).toContainElement(screen.getByText('corpo'))
    await user.click(btn)
    expect(screen.queryByText('corpo')).not.toBeInTheDocument()
  })

  it('tastiera: Enter/Space sul bottone apre e chiude', async () => {
    const user = userEvent.setup()
    render(<SectionCard title="Info"><p>corpo</p></SectionCard>)
    screen.getByRole('button', { name: 'Info' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('corpo')).toBeInTheDocument()
    await user.keyboard(' ')
    expect(screen.queryByText('corpo')).not.toBeInTheDocument()
  })

  it('defaultOpen apre subito; l\'intestazione aperta è colorata', () => {
    render(<SectionCard title="Info" defaultOpen activeColor="#123456"><p>corpo</p></SectionCard>)
    expect(screen.getByText('corpo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Info' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Info' }).parentElement).toHaveStyle({ background: '#123456' })
  })

  it('count aggiunge il badge al titolo', () => {
    render(<SectionCard title="Relazioni" count={4}><p>x</p></SectionCard>)
    expect(screen.getByRole('button', { name: 'Relazioni 4' })).toBeInTheDocument()
  })

  it('collapsible=false: nessun bottone, contenuto sempre visibile', () => {
    render(<SectionCard title="Fissa" collapsible={false}><p>corpo</p></SectionCard>)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('corpo')).toBeInTheDocument()
  })

  it('headerRight sta FUORI dal bottone (nessun controllo annidato)', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    render(
      <SectionCard title="Info" headerRight={<button type="button" onClick={onEdit}>Modifica</button>}>
        <p>corpo</p>
      </SectionCard>,
    )
    const toggle = screen.getByRole('button', { name: 'Info' })
    const edit = screen.getByRole('button', { name: 'Modifica' })
    expect(toggle).not.toContainElement(edit)
    await user.click(edit)
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('modalità controllata: open segue la prop e il click chiama onToggle senza stato interno', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const { rerender } = render(<SectionCard title="C" open={false} onToggle={onToggle} defaultOpen><p>corpo</p></SectionCard>)
    expect(screen.queryByText('corpo')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'C' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('corpo')).not.toBeInTheDocument()   // non si apre da sola
    rerender(<SectionCard title="C" open onToggle={onToggle}><p>corpo</p></SectionCard>)
    expect(screen.getByText('corpo')).toBeInTheDocument()
  })
})
