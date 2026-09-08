import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { TicketDetailPage } from './TicketDetailPage'
import { GET_MY_TICKET, GET_ME } from '@/graphql/queries'
import { ADD_TICKET_COMMENT } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const meMock: GqlMock = {
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'me-1', name: 'Mario Rossi', email: 'mario@acme.com', role: 'end_user' } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const TICKET = {
  __typename: 'Ticket', id: 'tk-1', type: 'incident', title: 'Printer broken', description: 'It smokes', status: 'in_progress',
  priority: 'high', category: 'hardware', createdAt: '2026-09-08T08:00:00Z', updatedAt: '2026-09-08T09:00:00Z', assignedTeam: 'Service Desk',
  comments: [
    { __typename: 'EntityComment', id: 'c1', body: 'Ciao, ho un problema', isInternal: false, authorId: 'me-1', authorName: 'Mario Rossi', authorEmail: 'mario@acme.com', createdAt: '2026-09-08T08:10:00Z' },
    { __typename: 'EntityComment', id: 'c2', body: 'Ci stiamo lavorando', isInternal: false, authorId: 'agent-1', authorName: 'Anna', authorEmail: 'anna@acme.com', createdAt: '2026-09-08T08:30:00Z' },
  ],
  attachments: [
    { __typename: 'Attachment', id: 'at1', filename: 'foto.png', mimeType: 'image/png', sizeBytes: 2048, uploadedBy: 'me-1', uploadedAt: '2026-09-08T08:00:00Z', downloadUrl: '/api/attachments/at1' },
  ],
  history: [
    { __typename: 'HistoryEntry', fromStep: 'new', toStep: 'in_progress', label: null, triggeredAt: '2026-09-08T08:20:00Z', triggeredBy: 'agent-1' },
  ],
}

const ticketMock = (data: typeof TICKET | null, opts: Partial<GqlMock> = {}): GqlMock => ({
  request: { query: GET_MY_TICKET, variables: { id: 'tk-1' } },
  result: { data: { myTicket: data } },
  maxUsageCount: Number.POSITIVE_INFINITY,
  ...opts,
})

const ROUTE = { route: '/tickets/tk-1', path: '/tickets/:id' }

describe('TicketDetailPage', () => {
  it('loading → "Loading..." (non "not found")', () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, { request: { query: GET_MY_TICKET, variables: { id: 'tk-1' } }, delay: Number.POSITIVE_INFINITY }] })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText(/Ticket not found/)).not.toBeInTheDocument()
  })

  it('errore (es. ticket di un altro utente) → banner role=alert con il messaggio e link indietro', async () => {
    const err: GqlMock = { request: { query: GET_MY_TICKET, variables: { id: 'tk-1' } }, error: new Error('Forbidden') }
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, err] })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Unable to load the ticket: Forbidden')
    expect(screen.getByRole('link', { name: '← Back' })).toHaveAttribute('href', '/tickets')
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('ticket assente → "Ticket not found or not accessible." con link indietro', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, ticketMock(null)] })
    expect(await screen.findByText('Ticket not found or not accessible.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Back' })).toHaveAttribute('href', '/tickets')
  })

  it('ticket caricato: titolo, stato, team, descrizione, timeline (commenti + cambi stato) e allegati', async () => {
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, ticketMock(TICKET)] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Printer broken' })).toBeInTheDocument()
    expect(screen.getByText('In progress')).toBeInTheDocument()
    expect(screen.getByText('Service Desk')).toBeInTheDocument()
    expect(screen.getByText('It smokes')).toBeInTheDocument()
    expect(screen.getByText('Ciao, ho un problema')).toBeInTheDocument()
    expect(screen.getByText('Ci stiamo lavorando')).toBeInTheDocument()
    expect(screen.getByText(/new → in_progress/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Attachments \(1\)/ }))
    expect(screen.getByRole('button', { name: /foto\.png/ })).toHaveTextContent('2 KB')
    expect(screen.queryByText(/This ticket has been resolved/)).not.toBeInTheDocument()
  })

  it('il messaggio "ticket creato" compare solo arrivando dalla creazione (location.state)', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, ticketMock(TICKET)] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    expect(screen.queryByText(/Ticket created!/)).not.toBeInTheDocument()
  })

  it('risposta: il bottone Reply è disabilitato senza testo e invia addTicketComment', async () => {
    const seen: unknown[] = []
    const addMock: GqlMock = {
      request: { query: ADD_TICKET_COMMENT, variables: (v) => { seen.push(v); return true } },
      result: { data: { addTicketComment: { __typename: 'EntityComment', id: 'c3', body: 'Grazie', isInternal: false, authorId: 'me-1', authorName: 'Mario Rossi', authorEmail: 'mario@acme.com', createdAt: '2026-09-08T10:00:00Z' } } },
    }
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, ticketMock(TICKET), addMock] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    const reply = screen.getByRole('button', { name: 'Reply' })
    expect(reply).toBeDisabled()
    await user.type(screen.getByPlaceholderText('Write your reply...'), 'Grazie')
    expect(reply).toBeEnabled()
    await user.click(reply)
    await waitFor(() => expect(seen).toContainEqual({ ticketId: 'tk-1', body: 'Grazie' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Write your reply...')).toHaveValue(''))
  })

  it('ticket chiuso → nessun form di risposta; risolto → banner con "Reopen ticket"', async () => {
    const { unmount } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, ticketMock({ ...TICKET, status: 'closed' })] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    expect(screen.queryByPlaceholderText('Write your reply...')).not.toBeInTheDocument()
    unmount()

    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, ticketMock({ ...TICKET, status: 'resolved' })] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    expect(screen.getByText(/This ticket has been resolved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen ticket' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Write your reply...')).toBeInTheDocument()
  })
})
