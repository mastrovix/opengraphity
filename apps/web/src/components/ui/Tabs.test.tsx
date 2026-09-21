import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Tabs, type TabItem } from './Tabs'
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

type Key = 'a' | 'b' | 'c'
const ITEMS: TabItem<Key>[] = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Beta', badge: 3 },
  { key: 'c', label: 'Gamma', badge: 0 },
]

function Controlled({ onChange }: { onChange?: (k: Key) => void }) {
  const [value, setValue] = useState<Key>('a')
  return <Tabs items={ITEMS} value={value} onChange={(k) => { setValue(k); onChange?.(k) }} ariaLabel="Sezioni" />
}

describe('Tabs', () => {
  it('tablist con nome, tab con aria-selected e roving tabindex', () => {
    render(<Controlled />)
    expect(screen.getByRole('tablist', { name: 'Sezioni' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('tabindex', '0')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[1]).toHaveAttribute('tabindex', '-1')
  })

  it('il badge compare solo se > 0', () => {
    render(<Controlled />)
    expect(screen.getByRole('tab', { name: 'Beta3' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Gamma' })).toBeInTheDocument()
  })

  it('click seleziona il tab', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('tab', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledWith('c')
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false')
  })

  it('frecce: destra/sinistra ciclano, Home/End vanno agli estremi, il focus segue', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    alpha.focus()

    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('b')
    expect(screen.getByRole('tab', { name: 'Beta3' })).toHaveFocus()

    await user.keyboard('{ArrowLeft}{ArrowLeft}')   // b → a → c (wrap)
    expect(onChange).toHaveBeenLastCalledWith('c')
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus()

    await user.keyboard('{ArrowRight}')              // c → a (wrap)
    expect(onChange).toHaveBeenLastCalledWith('a')

    await user.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith('c')
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith('a')
    expect(alpha).toHaveFocus()
  })

  it('altri tasti non cambiano selezione', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    screen.getByRole('tab', { name: 'Alpha' }).focus()
    await user.keyboard('{ArrowDown}x')
    expect(onChange).not.toHaveBeenCalled()
  })
})
