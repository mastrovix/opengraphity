/**
 * Giro nel browser del 14 set 2026 (#54): la ricerca globale non restituiva le
 * service request, e la tendina restava aperta dopo aver cambiato pagina.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { Link } from 'react-router-dom'
import { renderWithProviders } from '@/test/utils'
import { GlobalSearch } from '../GlobalSearch'

const query = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apollo', () => ({ apolloClient: { query } }))

const results = {
  cis: [], changes: [], incidents: [], problems: [], tasks: [], kbArticles: [], teams: [],
  serviceRequests: [{ id: 'sr-1', number: 'SR00000007', title: 'Portatile nuovo' }],
}

describe('GlobalSearch', () => {
  it('mostra il gruppo delle richieste e porta al dettaglio', async () => {
    query.mockResolvedValue({ data: { globalSearch: results } })
    const { user } = renderWithProviders(<GlobalSearch />)
    await user.type(screen.getByRole('combobox'), 'porta')
    expect(await screen.findByText('Service Requests')).toBeTruthy()
    await user.click(await screen.findByRole('option', { name: /SR00000007/ }))
    expect(screen.getByTestId('location').textContent).toBe('/requests/sr-1')
  })

  it('un cambio di pagina fuori dalla tendina la chiude', async () => {
    query.mockResolvedValue({ data: { globalSearch: results } })
    const { user } = renderWithProviders(<><GlobalSearch /><Link to="/changes">vai</Link></>)
    await user.type(screen.getByRole('combobox'), 'porta')
    await screen.findByRole('listbox')
    // la navigazione arriva da tastiera (nessun mousedown fuori)
    screen.getByRole('link', { name: 'vai' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('location').textContent).toBe('/changes')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
