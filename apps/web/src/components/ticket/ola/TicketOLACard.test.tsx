/** Secondo giro UI del 15 set 2026: gli OLA/UC non si vedevano nel dettaglio del ticket. */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { GET_TICKET_OLAS } from '@/graphql/queries'
import { TicketOLACard } from './TicketOLACard'

const row = (over: Record<string, unknown>) => ({
  __typename: 'TicketOLA', contractId: 'c1', name: 'Rete entro 4h', type: 'ola', teamName: 'Operazioni di rete', resolveMinutes: 240, calendarName: null,
  applies: true, reason: null, deadline: '2026-09-15T12:00:00.000Z', concludedAt: null, state: 'running', ...over,
})
const mock = (rows: unknown[]): GqlMock => ({ request: { query: GET_TICKET_OLAS, variables: { entityType: 'incident', entityId: 'inc-1' } }, result: { data: { ticketOLAs: rows } } })

describe('TicketOLACard', () => {
  it('i contratti che contano con scadenza e stato; quelli che non contano col motivo', async () => {
    renderWithProviders(<TicketOLACard entityType="incident" entityId="inc-1" />, { mocks: [mock([
      row({}),
      row({ contractId: 'c2', name: 'Sistemi 8h', teamName: 'Sistemi e Server', applies: false, reason: 'other_team', deadline: null, state: null }),
    ])] })
    const item = await screen.findByText('Rete entro 4h')
    const li = item.closest('li')!
    expect(within(li).getByText('Running')).toBeInTheDocument()
    expect(within(li).getByText(/Operazioni di rete · within 4h · 24×7/)).toBeInTheDocument()
    expect(within(li).getByText(/^Due /)).toBeInTheDocument()
    expect(screen.getByText('1 contract of this ticket type does not count:')).toBeInTheDocument()
    expect(screen.getByText('«Sistemi 8h» is the commitment of Sistemi e Server, and the ticket is assigned to another team.')).toBeInTheDocument()
  })

  it('nessun contratto del tipo: il riquadro non c\'è', async () => {
    const { container } = renderWithProviders(<TicketOLACard entityType="incident" entityId="inc-1" />, { mocks: [mock([])] })
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector('section, [data-section-card]')).toBeNull()
    expect(screen.queryByText('OLA / UC')).not.toBeInTheDocument()
  })
})
