/**
 * B0-3 (D-24 / B-10): la scheda «Aperti» mandava il NOME di passo `'open'`,
 * che nessun workflow definisce → lista sempre vuota, su qualunque tenant.
 * Ora manda una CLASSE, che l'API traduce nei passi del tenant; e se per quel
 * tenant la classe non esiste, la pagina lo DICE invece di mostrare zero righe.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { TicketListPage } from './TicketListPage'
import { GET_MY_TICKETS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const ticket = (id: string, status: string) => ({
  __typename: 'MyTicket', id, type: 'incident', title: `Ticket ${id}`, status,
  priority: 'high', category: 'hardware',
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z', assignedTeam: null,
})

/** Cattura le variabili di ogni MyTickets e risponde con i ticket dati. */
function ticketsMock(
  seen: Record<string, unknown>[],
  items: ReturnType<typeof ticket>[],
  match: (v: Record<string, unknown>) => boolean = () => true,
): GqlMock {
  return {
    request: { query: GET_MY_TICKETS, variables: (v) => { seen.push(v); return match(v) } },
    result: { data: { myTickets: { __typename: 'MyTicketsResult', items, total: items.length } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

describe('TicketListPage — le schede mandano una classe di stato', () => {
  it('all\'apertura nessun filtro; «Aperti» manda la classe `open`, non il nome di un passo', async () => {
    const seen: Record<string, unknown>[] = []
    const { user } = renderWithProviders(<TicketListPage />, {
      mocks: [ticketsMock(seen, [ticket('t-1', 'new'), ticket('t-2', 'assigned')])],
    })

    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[0]!['status']).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(seen.length).toBeGreaterThan(1))
    expect(seen[seen.length - 1]!['status']).toBe('open')

    // I ticket nei passi aperti del tenant compaiono: la scheda non è vuota.
    expect(await screen.findByText('Ticket t-1')).toBeInTheDocument()
    expect(screen.getByText('Ticket t-2')).toBeInTheDocument()
  })

  it('«In corso» manda `in_progress`, «Risolti» `resolved`, «Chiusi» `closed`', async () => {
    const seen: Record<string, unknown>[] = []
    const { user } = renderWithProviders(<TicketListPage />, { mocks: [ticketsMock(seen, [])] })
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))

    for (const [label, cls] of [['In progress', 'in_progress'], ['Resolved', 'resolved'], ['Closed', 'closed']] as const) {
      await user.click(screen.getByRole('button', { name: label }))
      await waitFor(() => expect(seen[seen.length - 1]!['status']).toBe(cls))
    }
  })

  it('fail-loud: se l\'API dice che il tenant non ha passi in quella classe, il messaggio è in pagina', async () => {
    const seen: Record<string, unknown>[] = []
    const { user } = renderWithProviders(<TicketListPage />, {
      mocks: [
        ticketsMock(seen, [ticket('t-1', 'new')], (v) => v['status'] !== 'open'),
        {
          request: { query: GET_MY_TICKETS, variables: (v) => v['status'] === 'open' },
          error: new Error('The incident workflow of tenant "acme" declares no step in the "open" class'),
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
      ],
    })
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))

    await user.click(screen.getByRole('button', { name: 'Open' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('I cannot list the tickets of this tab')
    expect(alert).toHaveTextContent(/declares no step in the "open" class/)
    // NON il vuoto rassicurante
    expect(screen.queryByText(/No open tickets|Nessun ticket/i)).not.toBeInTheDocument()
  })
})

/**
 * Giro nel browser del 14 set 2026: un incident aperto da un allarme non ha
 * categoria. L'API ora risponde `category: null` invece di far fallire
 * l'elenco, e la pagina non deve scrivere «null».
 */
describe('TicketListPage — ticket senza categoria', () => {
  it('si elenca senza scrivere «null»', async () => {
    const seen: Record<string, unknown>[] = []
    renderWithProviders(<TicketListPage />, { mocks: [ticketsMock(seen, [{ ...ticket('t-9', 'new'), category: null as unknown as string }])] })
    expect(await screen.findByText('Ticket t-9')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\bnull\b|ticket\.category/)
  })
})

/**
 * LE PAGINE.
 *
 * Compaiono solo quando ce n'e' piu' di una: due pulsanti spenti sotto tre
 * ticket sono rumore. E i pulsanti si spengono ai due estremi, invece di
 * chiedere al server una pagina che non esiste.
 */
describe('TicketListPage — la paginazione', () => {
  /** La pagina ne chiede quindici per volta: i totali qui sotto sono multipli di quello. */
  const PER_PAGINA = 15
  const molti = (n: number) => Array.from({ length: n }, (_, i) => ticket(`t${i}`, 'in_progress'))
  const paginato = (totale: number, seen: Record<string, unknown>[] = []): GqlMock => ({
    request: { query: GET_MY_TICKETS, variables: (v) => { seen.push(v); return true } },
    result: { data: { myTickets: { __typename: 'MyTicketsResult', items: molti(Math.min(totale, PER_PAGINA)), total: totale } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  })

  it('con una pagina sola non si mostra nessun comando', async () => {
    renderWithProviders(<TicketListPage />, { mocks: [paginato(3)] })
    await screen.findByText('Ticket t0')
    expect(screen.queryByRole('button', { name: /next|prev/i })).toBeNull()
  })

  it('con piu\' pagine si avanza e si torna, e la posizione si legge', async () => {
    const seen: Record<string, unknown>[] = []
    const { user } = renderWithProviders(<TicketListPage />, { mocks: [paginato(PER_PAGINA * 3, seen)] })
    await screen.findByText('Ticket t0')
    const posizione = () => screen.getByText((_t, el) => el?.tagName === 'SPAN' && /^\d+ \/ \d+$/.test(el.textContent ?? ''))
    expect(posizione().textContent).toBe('1 / 3')

    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => { expect(posizione().textContent).toBe('2 / 3') })
    expect(seen.at(-1)).toMatchObject({ page: 2 })

    await user.click(screen.getByRole('button', { name: /prev/i }))
    await waitFor(() => { expect(posizione().textContent).toBe('1 / 3') })
  })

  it('ai due estremi i pulsanti sono spenti: non si chiede una pagina che non c\'e\'', async () => {
    const { user } = renderWithProviders(<TicketListPage />, { mocks: [paginato(PER_PAGINA * 3)] })
    await screen.findByText('Ticket t0')
    expect((screen.getByRole('button', { name: /prev/i }) as HTMLButtonElement).disabled).toBe(true)

    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => {
      const posizione = screen.getByText((_t, el) => el?.tagName === 'SPAN' && /^\d+ \/ \d+$/.test(el.textContent ?? ''))
      expect(posizione.textContent).toBe('3 / 3')
    })
    expect((screen.getByRole('button', { name: /next/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})
