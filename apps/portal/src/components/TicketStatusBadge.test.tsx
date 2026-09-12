/**
 * TicketStatusBadge — ondata 7 · D-15.
 *
 * Prima lo stile veniva da una mappa di OTTO nomi di passo di fabbrica con
 * `?? grigio` per tutto il resto, e l'etichetta da `t('ticket.status.<nome>',
 * {defaultValue: nome})`: un passo aggiunto o rinominato nel disegnatore
 * diventava una pastiglia grigia col nome grezzo, in silenzio. Adesso lo stile
 * viene dalla CATEGORIA del passo (come nel web) e l'etichetta dal workflow
 * del cliente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { TicketStatusBadge, styleForStatusCategory } from './TicketStatusBadge'
import { renderWithProviders } from '@/test/utils'

let consoleWarn: ReturnType<typeof vi.spyOn>
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleWarn  = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('TicketStatusBadge', () => {
  it('passo di fabbrica: etichetta i18n del portale e colore della sua categoria', () => {
    renderWithProviders(<TicketStatusBadge status="in_progress" statusCategory="active" />)
    const pill = screen.getByText('In progress')
    expect(pill).toHaveStyle({ backgroundColor: styleForStatusCategory('active', 'in_progress').bg })
    expect(consoleWarn).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('passo RINOMINATO dal cliente: la sua etichetta e il colore della categoria — non una pastiglia grigia col nome grezzo', () => {
    renderWithProviders(<TicketStatusBadge status="in_verifica" statusCategory="waiting" statusLabel="In verifica" />)
    const pill = screen.getByText('In verifica')
    expect(pill).toHaveStyle({ backgroundColor: styleForStatusCategory('waiting', 'in_verifica').bg })
    // la categoria `waiting` ha un colore suo, diverso dal neutro dei chiusi
    expect(styleForStatusCategory('waiting', 'x')).not.toEqual(styleForStatusCategory('closed', 'x'))
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('passo senza etichetta nel workflow → nome ripulito, non il nome grezzo con gli underscore', () => {
    renderWithProviders(<TicketStatusBadge status="in_verifica" statusCategory="active" />)
    expect(screen.getByText('In verifica')).toBeInTheDocument()
  })

  it('passo SENZA categoria → neutro, e lo si dice (console.warn): configurazione incompleta, non errore', () => {
    renderWithProviders(<TicketStatusBadge status="in_verifica" statusCategory={null} />)
    expect(screen.getByText('In verifica')).toHaveStyle({ backgroundColor: 'var(--color-slate-bg)' })
    expect(consoleWarn).toHaveBeenCalledWith('[TicketStatusBadge] il passo "in_verifica" non dichiara una categoria: pastiglia neutra')
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('categoria che il portale non conosce → neutro e console.error (è il prodotto a essere indietro)', () => {
    renderWithProviders(<TicketStatusBadge status="x" statusCategory="inventata" />)
    expect(consoleError).toHaveBeenCalledWith('[TicketStatusBadge] categoria sconosciuta "inventata" sul passo "x"')
  })
})
