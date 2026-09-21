/**
 * I tipi di CI esclusi per tipo di ticket (revisione del 15 set 2026 · CM-8):
 * al posto delle regole «tipi ammessi» con tipo di relazione e direzione che
 * nessuno leggeva, una scelta multipla dei tipi esclusi.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { ITILTypeCIExclusions } from './ITILTypeCIExclusions'
import { GET_TICKET_CI_EXCLUSIONS } from '@/graphql/queries'
import { SET_TICKET_CI_EXCLUSIONS } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const CI_TYPES = [
  { id: 't1', name: 'server', label: 'Server' },
  { id: 't2', name: 'certificate', label: 'Certificate' },
]
const read = (ciTypes: string[]): GqlMock => ({
  request: { query: GET_TICKET_CI_EXCLUSIONS, variables: { ticketType: 'incident' } },
  result: { data: { ticketCIExclusions: [{ __typename: 'TicketCIExclusions', ticketType: 'incident', ciTypes }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('ITILTypeCIExclusions', () => {
  it('le esclusioni salvate sono spuntate, e «Salva» manda l\'elenco intero dei tipi esclusi', async () => {
    let sent = false
    // Le variabili esatte: il mock risponde solo se arriva l'elenco intero (quello salvato più il nuovo).
    const save: GqlMock = {
      request: { query: SET_TICKET_CI_EXCLUSIONS, variables: { ticketType: 'incident', ciTypes: ['certificate', 'server'] } },
      result: () => { sent = true; return { data: { setTicketCIExclusions: { __typename: 'TicketCIExclusions', ticketType: 'incident', ciTypes: ['certificate', 'server'] } } } },
    }
    const { user } = renderWithProviders(<ITILTypeCIExclusions ticketType="incident" ciTypes={CI_TYPES} />, { mocks: [read(['certificate']), save] })
    const cert = await screen.findByRole('checkbox', { name: 'Certificate' })
    expect(cert).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Server' })).not.toBeChecked()
    const saveButton = screen.getByRole('button', { name: /Save/ })
    expect(saveButton).toBeDisabled()   // niente da salvare

    await user.click(screen.getByRole('checkbox', { name: 'Server' }))
    await user.click(saveButton)
    await waitFor(() => expect(sent).toBe(true))
  })

  it('senza spunte lo dice: ogni tipo di CI si può collegare', async () => {
    renderWithProviders(<ITILTypeCIExclusions ticketType="incident" ciTypes={CI_TYPES} />, { mocks: [read([])] })
    expect(await screen.findByText(/every CI type can be linked/)).toBeInTheDocument()
  })
})
