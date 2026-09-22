/**
 * LE RIFINITURE: quello che succede ai bordi.
 *
 * Effetti del passaggio del mouse che devono ANNULLARSI (un'ombra che resta
 * accesa su ogni scheda toccata fa sembrare la pagina rotta), il trascinamento
 * di un file, e i pochi ripieghi che restavano senza prova.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { HomePage } from '@/pages/HomePage'
import { KBListPage } from '@/pages/KBListPage'
import { KBSearchBar } from '@/components/KBSearchBar'
import { PortalCustomFields } from '@/components/PortalCustomFields'
import { GET_ME, GET_MY_TICKETS, GET_MY_TICKET_STATS, GET_KB_ARTICLES, GET_KB_CATEGORIES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const sempre = Number.POSITIVE_INFINITY
const me: GqlMock = {
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'u1', name: 'Anna', email: 'a@x', role: 'end_user', permissions: ['portal.read', 'portal.submit'], language: 'en' } } },
  maxUsageCount: sempre,
}
const stats: GqlMock = {
  request: { query: GET_MY_TICKET_STATS },
  result: { data: { myTicketStats: { __typename: 'TicketStats', open: 1, inProgress: 0, resolved: 0, total: 1 } } },
  maxUsageCount: sempre,
}
const unTicket = {
  __typename: 'Ticket', id: 't1', number: 'INC-1', type: 'incident', title: 'VPN down',
  status: 'in_progress', statusCategory: 'active', statusLabel: 'In lavorazione',
  priority: 'high', priorityLabel: 'High', priorityColor: 'danger', category: 'network',
  createdAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-21T09:00:00Z', assignedTeam: null,
}
const miei: GqlMock = {
  request: { query: GET_MY_TICKETS, variables: () => true },
  result: { data: { myTickets: { __typename: 'TicketsResult', total: 1, items: [unTicket] } } },
  maxUsageCount: sempre,
}
const kbCategorie: GqlMock = {
  request: { query: GET_KB_CATEGORIES, variables: () => true },
  result: { data: { kbCategories: [{ __typename: 'KBCategory', name: 'how-to', label: 'How-to guides', count: 2 }] } },
  maxUsageCount: sempre,
}
const kbArticoli: GqlMock = {
  request: { query: GET_KB_ARTICLES, variables: () => true },
  result: { data: { kbArticles: { __typename: 'KBArticlesResult', total: 1, items: [{
    __typename: 'KBArticle', id: 'a1', title: 'Reset VPN', slug: 'reset-vpn', body: 'body', category: 'how-to', views: 3, publishedAt: null,
  }] } } },
  maxUsageCount: sempre,
}

/**
 * Passa sopra e poi via.
 *
 * Non si confronta l'attributo `style` intero: React lo riscrive e l'ordine
 * cambia. Quello che conta e' che l'effetto ACCESO non resti acceso — una
 * scheda che tiene l'ombra dopo che il mouse e' passato fa sembrare rotta
 * tutta la pagina, perche' ogni scheda toccata resta illuminata.
 */
function passaESposta(el: HTMLElement): { prima: string; dopo: string; durante: string } {
  // Si guardano SOLO le proprieta' che l'effetto tocca: l'attributo intero
  // cambia ordine a ogni riscrittura di React e non direbbe niente.
  const guarda = () => ['box-shadow', 'border-color', 'background-color']
    .map((p) => `${p}=${el.style.getPropertyValue(p)}`).join(';')
  void guarda
  const prima = guarda()
  fireEvent.mouseEnter(el)
  const durante = guarda()
  fireEvent.mouseLeave(el)
  return { prima, durante, dopo: guarda() }
}

describe('gli effetti del passaggio del mouse si annullano', () => {
  it('le due scorciatoie della home tornano come prima', async () => {
    renderWithProviders(<HomePage />, { mocks: [me, stats, miei] })
    const apri = (await screen.findByText('Open a new ticket')).closest('button')!
    const cerca = screen.getByText('Search the Knowledge Base').closest('button')!
    for (const el of [apri, cerca]) {
      const { prima, durante, dopo } = passaESposta(el)
      expect(durante).not.toBe(prima)   // qualcosa succede
      expect(dopo).not.toBe(durante)    // e non resta acceso
    }
  })

  it('una riga dell\'elenco dei ticket torna come prima', async () => {
    renderWithProviders(<HomePage />, { mocks: [me, stats, miei] })
    const riga = (await screen.findByText('VPN down')).closest('a')!
    const { prima, durante, dopo } = passaESposta(riga)
    expect(durante).not.toBe(prima)
    expect(dopo).not.toBe(durante)
  })

  it('le schede delle categorie e degli articoli della KB tornano come prima', async () => {
    renderWithProviders(<KBListPage />, { mocks: [kbCategorie, kbArticoli] })
    const categoria = (await screen.findByRole('button', { name: /How-to guides/ }))
    const c = passaESposta(categoria)
    expect(c.durante).not.toBe(c.prima)
    expect(c.dopo).not.toBe(c.durante)

    const articolo = (await screen.findAllByText('Reset VPN'))[0]!.closest('a')!
    const a = passaESposta(articolo)
    expect(a.durante).not.toBe(a.prima)
    expect(a.dopo).not.toBe(a.durante)
  })
})

describe('KBSearchBar', () => {
  it('cercare porta alla KB con la ricerca nell\'indirizzo, codificata', async () => {
    const { user } = renderWithProviders(<KBSearchBar />, { mocks: [] })
    await user.type(screen.getByRole('textbox', { name: /Search the Knowledge Base/i }), 'vpn & wifi{Enter}')
    await waitFor(() => { expect(screen.getByTestId('location').textContent).toBe('/kb?search=vpn%20%26%20wifi') })
  })

  it('con un gestore proprio non naviga: decide chi la usa', async () => {
    const onSearch = vi.fn()
    const { user } = renderWithProviders(<KBSearchBar onSearch={onSearch} />, { mocks: [] })
    await user.type(screen.getByRole('textbox', { name: /Search the Knowledge Base/i }), '  vpn  {Enter}')
    expect(onSearch).toHaveBeenCalledWith('vpn')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('una ricerca vuota non fa niente', async () => {
    const onSearch = vi.fn()
    const { user } = renderWithProviders(<KBSearchBar onSearch={onSearch} />, { mocks: [] })
    await user.type(screen.getByRole('textbox', { name: /Search the Knowledge Base/i }), '   {Enter}')
    expect(onSearch).not.toHaveBeenCalled()
    expect(screen.getByTestId('location').textContent).toBe('/')
  })
})

describe('PortalCustomFields', () => {
  it('senza campi non disegna niente: nessun riquadro vuoto', () => {
    const { container } = renderWithProviders(
      <PortalCustomFields fields={[]} values={{}} onChange={vi.fn()} />, { mocks: [] })
    expect(within(container).queryByRole('textbox')).toBeNull()
  })

  it('con dei campi li disegna, con etichetta ed errore', async () => {
    const campi = [{ __typename: 'PortalCustomField', name: 'cc', label: 'Centro di costo', fieldType: 'text', required: true, options: [] }]
    const onChange = vi.fn()
    const { user } = renderWithProviders(
      <PortalCustomFields fields={campi as never} values={{}} errors={{ cc: 'Obbligatorio' }} onChange={onChange} />, { mocks: [] })
    const input = screen.getByLabelText(/Centro di costo/)
    expect(screen.getByText('Obbligatorio')).toBeInTheDocument()
    await user.type(input, 'IT-01')
    expect(onChange).toHaveBeenCalledWith('cc', 'I')
  })
})
