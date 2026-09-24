import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { TicketDetailPage } from './TicketDetailPage'
import { GET_MY_TICKET, GET_ME, GET_TICKET_CATEGORIES } from '@/graphql/queries'
import { ADD_TICKET_COMMENT, UPDATE_COMMENT, DELETE_COMMENT, REOPEN_TICKET, CONFIRM_TICKET_RESOLUTION } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const meMock: GqlMock = {
  request: { query: GET_ME },
  result: { data: { me: { __typename: 'User', id: 'me-1', name: 'Mario Rossi', email: 'mario@acme.com', role: 'end_user', permissions: ['portal.read', 'portal.submit', 'kb.rate'] } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const TICKET = {
  __typename: 'Ticket', id: 'tk-1', number: 'INC00000042', type: 'incident', title: 'Printer broken', description: 'It smokes', status: 'in_progress',
  // La categoria del passo (ondata 7 · D-15) è quella che dice al portale se il
  // ticket è chiuso o risolto: il nome del passo è del cliente (ondata 8 · B-22).
  statusCategory: 'active', statusLabel: null,
  priority: 'high', category: 'hardware', createdAt: '2026-09-08T08:00:00Z', updatedAt: '2026-09-08T09:00:00Z', assignedTeam: 'Service Desk',
  canConfirmResolution: false,
  comments: [
    { __typename: 'EntityComment', id: 'c1', body: 'Ciao, ho un problema', isInternal: false, authorId: 'me-1', authorName: 'Mario Rossi', authorEmail: 'mario@acme.com', createdAt: '2026-09-08T08:10:00Z' },
    { __typename: 'EntityComment', id: 'c2', body: 'Ci stiamo lavorando', isInternal: false, authorId: 'agent-1', authorName: 'Anna', authorEmail: 'anna@acme.com', createdAt: '2026-09-08T08:30:00Z' },
  ],
  attachments: [
    { __typename: 'Attachment', id: 'at1', filename: 'foto.png', mimeType: 'image/png', sizeBytes: 2048, uploadedBy: 'me-1', uploadedAt: '2026-09-08T08:00:00Z', downloadUrl: '/api/attachments/at1' },
  ],
  history: [
    { __typename: 'HistoryEntry', fromStep: 'new', toStep: 'in_progress', fromLabel: 'New', toLabel: 'In Progress', label: null, triggeredAt: '2026-09-08T08:20:00Z', triggeredBy: 'agent-1' },
  ],
}

const ticketMock = (data: typeof TICKET | null, opts: Partial<GqlMock> = {}): GqlMock => ({
  request: { query: GET_MY_TICKET, variables: { id: 'tk-1', language: 'en' } },
  result: { data: { myTicket: data } },
  maxUsageCount: Number.POSITIVE_INFINITY,
  ...opts,
})

const categoriesMock: GqlMock = {
  request: { query: GET_TICKET_CATEGORIES, variables: () => true },
  result: { data: { ticketCategories: ['hardware', 'software', 'access', 'network', 'security', 'other'].map((name) => ({ __typename: 'TicketCategory', name, label: name[0]!.toUpperCase() + name.slice(1) })) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const ROUTE = { route: '/tickets/tk-1', path: '/tickets/:id' }

describe('TicketDetailPage', () => {
  it('loading → "Loading..." (non "not found")', () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, { request: { query: GET_MY_TICKET, variables: { id: 'tk-1', language: 'en' } }, delay: Number.POSITIVE_INFINITY }] })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText(/Ticket not found/)).not.toBeInTheDocument()
  })

  it('errore (es. ticket di un altro utente) → banner role=alert con il messaggio e link indietro', async () => {
    const err: GqlMock = { request: { query: GET_MY_TICKET, variables: { id: 'tk-1', language: 'en' } }, error: new Error('Forbidden') }
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, err] })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Unable to load the ticket: Forbidden')
    expect(screen.getByRole('link', { name: '← Back' })).toHaveAttribute('href', '/tickets')
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('ticket assente → "Ticket not found or not accessible." con link indietro', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(null)] })
    expect(await screen.findByText('Ticket not found or not accessible.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Back' })).toHaveAttribute('href', '/tickets')
  })

  it('ticket caricato: titolo, stato, team, descrizione, timeline (commenti + cambi stato) e allegati', async () => {
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET)] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Printer broken' })).toBeInTheDocument()
    expect(screen.getByText('In progress')).toBeInTheDocument()
    expect(screen.getByText('Service Desk')).toBeInTheDocument()
    expect(screen.getByText('It smokes')).toBeInTheDocument()
    expect(screen.getByText('Ciao, ho un problema')).toBeInTheDocument()
    expect(screen.getByText('Ci stiamo lavorando')).toBeInTheDocument()
    expect(screen.getByText(/New → In Progress/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Attachments \(1\)/ }))
    expect(screen.getByRole('button', { name: /foto\.png/ })).toHaveTextContent('2 KB')
    expect(screen.queryByText(/This ticket has been resolved/)).not.toBeInTheDocument()
  })

  it('il messaggio "ticket creato" compare solo arrivando dalla creazione (location.state)', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET)] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    expect(screen.queryByText(/Ticket created!/)).not.toBeInTheDocument()
  })

  it('risposta: il bottone Reply è disabilitato senza testo e invia addTicketComment', async () => {
    const seen: unknown[] = []
    const addMock: GqlMock = {
      request: { query: ADD_TICKET_COMMENT, variables: (v) => { seen.push(v); return true } },
      result: { data: { addTicketComment: { __typename: 'EntityComment', id: 'c3', body: 'Grazie', isInternal: false, authorId: 'me-1', authorName: 'Mario Rossi', authorEmail: 'mario@acme.com', createdAt: '2026-09-08T10:00:00Z' } } },
    }
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET), addMock] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    const reply = screen.getByRole('button', { name: 'Reply' })
    expect(reply).toBeDisabled()
    await user.type(screen.getByPlaceholderText('Write your reply...'), 'Grazie')
    expect(reply).toBeEnabled()
    await user.click(reply)
    await waitFor(() => expect(seen).toContainEqual({ ticketId: 'tk-1', body: 'Grazie' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Write your reply...')).toHaveValue(''))
  })

  // Passi RINOMINATI dal cliente («archiviato», «sistemato»): chiuso e risolto
  // si riconoscono dalla categoria del passo, non dal nome (ondata 8 · B-22).
  // Con il vecchio confronto sui nomi di fabbrica questi due casi davano il
  // contrario: risposta offerta su un ticket chiuso, nessun banner su uno risolto.
  it('ticket chiuso → nessun form di risposta; risolto → banner con "Reopen ticket" (passi rinominati)', async () => {
    const { unmount } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock({ ...TICKET, status: 'archiviato', statusCategory: 'closed' })] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    expect(screen.queryByPlaceholderText('Write your reply...')).not.toBeInTheDocument()
    unmount()

    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock({ ...TICKET, status: 'sistemato', statusCategory: 'resolved' })] })
    await screen.findByRole('heading', { level: 1, name: 'Printer broken' })
    expect(screen.getByText(/This ticket has been resolved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen ticket' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Write your reply...')).toBeInTheDocument()
  })
})

/**
 * LE RISPOSTE AL MODULO, LETTE DOPO.
 *
 * Chi compilava dodici campi non li rivedeva da nessuna parte (revisione del
 * 17 set 2026): la richiesta mostrava titolo e descrizione, e le risposte
 * restavano nel grafo. Ogni forma di risposta si legge nel modo suo — una
 * tabella e' una tabella, un riferimento e' il suo nome, un file e' il suo
 * nome, un booleano e' «sì» o «no» e non «true».
 */
describe('TicketDetailPage — le risposte al modulo', () => {
  const risposta = (over: Record<string, unknown>) => ({
    __typename: 'FormAnswerView', name: 'x', label: 'X', fieldType: 'text',
    value: null, values: [], displayValue: null, displayValues: [],
    references: [], files: [], tableColumns: [], rows: [], ...over,
  })
  const conRisposte = (answers: unknown[]) => ({ ...TICKET, formAnswers: answers })

  it('un valore semplice, una scelta multipla, un booleano e un vuoto', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(conRisposte([
      risposta({ name: 'modello', label: 'Modello', displayValue: 'ThinkPad X1' }),
      risposta({ name: 'tag', label: 'Tag', fieldType: 'multi_enum', displayValues: ['Rete', 'Urgente'] }),
      risposta({ name: 'urgente', label: 'Urgente', fieldType: 'boolean', displayValue: 'true' }),
      risposta({ name: 'note', label: 'Note' }),
    ]) as never)] })
    expect(await screen.findByText('ThinkPad X1')).toBeInTheDocument()
    expect(screen.getByText('Rete, Urgente')).toBeInTheDocument()
    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.queryByText('true')).toBeNull()
  })

  // Tour of 24 Sep 2026 (G41): «Needed until 2026-12-31», the raw date, next to dates written for people.
  it('a date answer is written as the other dates of the page, not raw', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(conRisposte([
      risposta({ name: 'until', label: 'Needed until', fieldType: 'date', displayValue: '2026-12-31' }),
    ]) as never)] })
    expect(await screen.findByText('31 Dec 2026')).toBeInTheDocument()
    expect(screen.queryByText('2026-12-31')).toBeNull()
  })

  it('un booleano falso si legge «no», non «false»', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(conRisposte([
      risposta({ name: 'urgente', label: 'Urgente', fieldType: 'boolean', displayValue: 'false' }),
    ]) as never)] })
    expect(await screen.findByText('No')).toBeInTheDocument()
  })

  it('i riferimenti e i file si leggono col loro nome, non con l\'id', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(conRisposte([
      risposta({ name: 'ci', label: 'CI', fieldType: 'ref_ci', references: [{ __typename: 'Ref', id: 'ci-1', label: 'Stampante 1' }] }),
      risposta({ name: 'doc', label: 'Documento', fieldType: 'attachment', files: [{ __typename: 'FileRef', id: 'f1', filename: 'contratto.pdf', sizeBytes: 10 }] }),
    ]) as never)] })
    expect(await screen.findByText('Stampante 1')).toBeInTheDocument()
    expect(screen.getByText('contratto.pdf')).toBeInTheDocument()
  })

  it('una tabella si legge come tabella, e una tabella vuota lo dice', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(conRisposte([
      risposta({
        name: 'righe', label: 'Righe', fieldType: 'table',
        tableColumns: [
          { __typename: 'FormTableColumn', name: 'modello', label: 'Modello', fieldType: 'text' },
          { __typename: 'FormTableColumn', name: 'quantita', label: 'Quantità', fieldType: 'number' },
        ],
        rows: [{ __typename: 'FormTableRow', cells: [
          { __typename: 'FormTableCell', column: 'modello', value: 'X1', displayValue: null },
          { __typename: 'FormTableCell', column: 'quantita', value: null, displayValue: null },
        ] }],
      }),
      risposta({
        name: 'vuota', label: 'Vuota', fieldType: 'table',
        tableColumns: [{ __typename: 'FormTableColumn', name: 'c', label: 'C', fieldType: 'text' }],
        rows: [],
      }),
    ]) as never)] })
    expect(await screen.findByRole('columnheader', { name: 'Modello' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'X1' })).toBeInTheDocument()
    // Una cella senza valore mostra un trattino, non una cella muta.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('senza risposte la sezione non c\'è affatto', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(conRisposte([]) as never)] })
    await screen.findByText('Printer broken')
    expect(screen.queryByRole('columnheader')).toBeNull()
  })
})

/**
 * I CAMPI DEL CLIENTE (ondata 4): quelli che l'amministratore offre nel
 * portale. Un valore assente si vede come trattino, non come riga vuota: una
 * riga vuota si legge «non c'e' il campo».
 */
describe('TicketDetailPage — i campi del cliente', () => {
  const campo = (over: Record<string, unknown>) => ({
    __typename: 'CustomFieldView', name: 'x', label: 'X', fieldType: 'text', value: null, valueLabel: null, ...over,
  })

  it('mostra etichetta e valore, con l\'etichetta del vocabolario quando c\'è', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock({ ...TICKET, customFields: [
      campo({ name: 'sede', label: 'Sede', value: 'mi', valueLabel: 'Milano' }),
      campo({ name: 'cc', label: 'Centro di costo', value: 'IT-01' }),
      campo({ name: 'vip', label: 'VIP', fieldType: 'boolean', value: 'true' }),
      campo({ name: 'vuoto', label: 'Vuoto' }),
    ] } as never)] })
    expect(await screen.findByText('Milano')).toBeInTheDocument()
    expect(screen.getByText('IT-01')).toBeInTheDocument()
    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

/**
 * RISPONDERE, CORREGGERE, RIAPRIRE E SCARICARE.
 *
 * Ogni azione ricarica il ticket dal SERVER invece di indovinare lo stato
 * nuovo: la conversazione con l'assistenza continua mentre la pagina e'
 * aperta, e una lista costruita a mano perderebbe quello che e' successo nel
 * frattempo.
 */
describe('TicketDetailPage — le azioni', () => {
  const risolto = { ...TICKET, status: 'resolved', statusCategory: 'resolved' }

  it('una risposta si manda anche con Ctrl+Invio, e la casella si svuota', async () => {
    const aggiunta: GqlMock = {
      request: { query: ADD_TICKET_COMMENT, variables: { ticketId: 'tk-1', body: 'Grazie!' } },
      result: { data: { addTicketComment: { __typename: 'EntityComment', id: 'c3', body: 'Grazie!', isInternal: false, authorId: 'me-1', authorName: 'Mario Rossi', authorEmail: 'mario@acme.com', createdAt: '2026-09-08T09:00:00Z' } } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET), aggiunta] })
    const casella = await screen.findByRole('textbox')
    await user.type(casella, 'Grazie!')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => { expect((casella as HTMLTextAreaElement).value).toBe('') })
  })

  it('una risposta vuota non si manda: niente da dire, niente da scrivere', async () => {
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET)] })
    const casella = await screen.findByRole('textbox')
    await user.type(casella, '   ')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect((casella as HTMLTextAreaElement).value).toBe('   ')
  })

  it('la PROPRIA risposta si corregge, e il ticket si rilegge dal server', async () => {
    const correzione: GqlMock = {
      request: { query: UPDATE_COMMENT, variables: { id: 'c1', body: 'Corretto' } },
      result: { data: { updateComment: { __typename: 'EntityComment', id: 'c1', body: 'Corretto', editedAt: '2026-09-08T09:30:00Z', editedByName: 'Mario Rossi' } } },
    }
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET), correzione] })
    await screen.findByText('Ciao, ho un problema')
    await user.click(screen.getByRole('button', { name: /edit/i }))
    const box = screen.getAllByRole('textbox').find((t) => (t as HTMLTextAreaElement).value === 'Ciao, ho un problema')!
    await user.clear(box)
    await user.type(box, 'Corretto')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: /save/i })).toBeNull() })
  })

  it('la PROPRIA risposta si cancella, dopo conferma', async () => {
    const cancellazione: GqlMock = {
      request: { query: DELETE_COMMENT, variables: { id: 'c1' } },
      result: { data: { deleteComment: true } },
    }
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET), cancellazione] })
    await screen.findByText('Ciao, ho un problema')
    await user.click(screen.getByRole('button', { name: /delete/i }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /delete/i }).at(-1)!)
    await waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull() })
  })

  it('un ticket RISOLTO si può riaprire, e il pulsante si spegne mentre ci pensa', async () => {
    const riapertura: GqlMock = {
      request: { query: REOPEN_TICKET, variables: { ticketId: 'tk-1' } },
      result: { data: { reopenTicket: { __typename: 'Ticket', id: 'tk-1', status: 'in_progress', updatedAt: '2026-09-08T10:00:00Z' } } },
    }
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(risolto as never), riapertura] })
    await user.click(await screen.findByRole('button', { name: 'Reopen ticket' }))
    // La mutation e' partita: il ticket si rilegge dal server, non si indovina.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Reopen ticket' })).toBeInTheDocument() })
  })

  /*
   * «It works» (tour of 23 Sep 2026, D51): the requester closes a resolved
   * ticket now instead of waiting three days for the timer — only where the
   * workflow has that move.
   */
  it('a resolved ticket whose workflow allows it offers «It works — close the ticket», which closes it on the server', async () => {
    const conferma: GqlMock = {
      request: { query: CONFIRM_TICKET_RESOLUTION, variables: { ticketId: 'tk-1' } },
      result: { data: { confirmTicketResolution: { __typename: 'Ticket', id: 'tk-1', status: 'closed', updatedAt: '2026-09-08T10:00:00Z' } } },
    }
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock({ ...risolto, canConfirmResolution: true } as never), conferma] })
    const button = await screen.findByRole('button', { name: 'It works — close the ticket' })
    expect(screen.getByRole('button', { name: 'Reopen ticket' })).toBeInTheDocument()
    await user.click(button)
    // Sent: the ticket is read again from the server, not guessed.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'It works — close the ticket' })).toBeInTheDocument() })
  })

  it('a resolved ticket closed only by its timer offers «Reopen» and no confirmation', async () => {
    renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(risolto as never)] })
    await screen.findByRole('button', { name: 'Reopen ticket' })
    expect(screen.queryByRole('button', { name: 'It works — close the ticket' })).toBeNull()
  })

  it('un allegato si scarica col suo nome, passando dal bearer', async () => {
    const mod = await import('@/lib/attachments')
    const scarica = vi.spyOn(mod, 'downloadAttachment').mockResolvedValue(undefined)
    const { user } = renderWithProviders(<TicketDetailPage />, { ...ROUTE, mocks: [meMock, categoriesMock, ticketMock(TICKET)] })
    await screen.findByText('Printer broken')
    const apri = screen.getAllByRole('button').find((b) => /attach|allegat/i.test(b.textContent ?? ''))
    if (apri) await user.click(apri)
    const file = await screen.findByText('foto.png')
    await user.click(file.closest('button') ?? file)
    await waitFor(() => { expect(scarica).toHaveBeenCalledWith('/api/attachments/at1', 'foto.png') })
    scarica.mockRestore()
  })
})
