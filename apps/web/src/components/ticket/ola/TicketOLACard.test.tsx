/** Secondo giro UI del 15 set 2026: gli OLA/UC nel dettaglio del ticket, misurati come tempo del team. */
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_TICKET_OLAS } from '@/graphql/queries'
import { TicketOLACard } from './TicketOLACard'

const row = (over: Record<string, unknown>) => ({
  __typename: 'TicketOLA', contractId: 'c1', name: 'Rete entro 4h', type: 'ola', teamName: 'Operazioni di rete', resolveMinutes: 240, calendarName: null,
  applies: true, reason: null, deadline: '2026-09-15T12:00:00.000Z', concludedAt: null, state: 'running',
  usedMinutes: 90, remainingMinutes: 150, inferred: false,
  unitKind: null, unitKey: null, ciName: null, responderRole: null, stepTitle: null, startsAt: null, ...over,
})
const mock = (rows: unknown[], entityType = 'incident', entityId = 'inc-1'): GqlMock => ({ request: { query: GET_TICKET_OLAS, variables: { entityType, entityId } }, result: { data: { ticketOLAs: rows } } })

describe('TicketOLACard', () => {
  it('in corso: tempo del team usato sull\'obiettivo e scadenza se il team lo tiene; chi non conta col motivo', async () => {
    renderWithProviders(<TicketOLACard entityType="incident" entityId="inc-1" />, { mocks: [mock([
      row({}),
      row({ contractId: 'c2', name: 'Sistemi 8h', teamName: 'Sistemi e Server', applies: false, reason: 'other_team', deadline: null, state: null, usedMinutes: 0 }),
      row({ contractId: 'c3', name: 'Service Desk 1h', teamName: 'Service Desk', applies: false, reason: 'before_contract', deadline: null, state: null, usedMinutes: 0 }),
    ])] })
    const li = (await screen.findByText('Rete entro 4h')).closest('li')!
    expect(within(li).getByText('Running')).toBeInTheDocument()
    expect(within(li).getByText(/Operazioni di rete · within 4h · 24×7/)).toBeInTheDocument()
    expect(within(li).getByText(/^Team time 1h 30min of 4h · due .+ if the team keeps it$/)).toBeInTheDocument()
    expect(within(li).queryByText(/older than the assignment history/)).not.toBeInTheDocument()
    expect(screen.getByText('2 contracts of this ticket type do not count:')).toBeInTheDocument()
    expect(screen.getByText('«Sistemi 8h» is the commitment of Sistemi e Server, and the ticket has never been with that team.')).toBeInTheDocument()
    expect(screen.getByText('«Service Desk 1h» is the commitment of Service Desk, which had the ticket only before the contract existed.')).toBeInTheDocument()
  })

  it('passato ad altri, violato e ricostruito dall\'apertura: ognuno lo dice', async () => {
    renderWithProviders(<TicketOLACard entityType="incident" entityId="inc-1" />, { mocks: [mock([
      row({ state: 'handed_off', deadline: null }),
      row({ contractId: 'c2', name: 'Fornitore 8h', type: 'uc', state: 'breached', deadline: null, usedMinutes: 500, resolveMinutes: 480, inferred: true }),
    ])] })
    const handed = (await screen.findByText('Rete entro 4h')).closest('li')!
    expect(within(handed).getByText('Handed off')).toBeInTheDocument()
    expect(within(handed).getByText(/now with another team: the time stops until it comes back/)).toBeInTheDocument()
    const breached = screen.getByText('Fornitore 8h').closest('li')!
    expect(within(breached).getByText('Breached')).toBeInTheDocument()
    expect(within(breached).getByText(/^Team time 8h 20min of 8h$/)).toBeInTheDocument()
    expect(within(breached).getByText(/older than the assignment history/)).toBeInTheDocument()
  })

  it('change: una riga per misura dei task, con il tipo di task, il CI e il passo; la validazione non ancora iniziata è pianificata', async () => {
    renderWithProviders(<TicketOLACard entityType="change" entityId="chg-7" />, { mocks: [mock([
      row({ unitKind: 'assessment', unitKey: 'assessment:at-1', ciName: 'Portale', responderRole: 'support', state: 'met', inferred: true, concludedAt: '2026-09-15T11:00:00.000Z', deadline: null, usedMinutes: 30 }),
      row({ unitKind: 'validation', unitKey: 'validation:dp-1:0', ciName: 'Portale', stepTitle: 'Rilascio 2.4', state: 'scheduled', startsAt: '2026-09-17T07:00:00.000Z', deadline: '2026-09-17T11:00:00.000Z', usedMinutes: 0 }),
    ], 'change', 'chg-7')] })
    // Niente in corso né violato: il riquadro nasce chiuso.
    fireEvent.click(await screen.findByRole('button', { name: /OLA \/ UC/ }))
    const assessment = screen.getByText('Technical assessment · Portale').closest('li')!
    expect(within(assessment).getByText('Met')).toBeInTheDocument()
    expect(within(assessment).getByText(/the task is older than the assignment history/)).toBeInTheDocument()
    const validation = screen.getByText('Validation · Portale · Rilascio 2.4').closest('li')!
    expect(within(validation).getByText('Scheduled')).toBeInTheDocument()
    expect(within(validation).getByText(/^The team time starts .+, when the plan's window opens · due /)).toBeInTheDocument()
  })

  it('nessun contratto del tipo: il riquadro non c\'è', async () => {
    const { container } = renderWithProviders(<TicketOLACard entityType="incident" entityId="inc-1" />, { mocks: [mock([])] })
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector('section, [data-section-card]')).toBeNull()
    expect(screen.queryByText('OLA / UC')).not.toBeInTheDocument()
  })
})
