/**
 * Personalizzazioni, ondata 8 — A8-3 (B-22): «Richiedi Change» compare finché
 * l'incident è APERTO secondo i metadata del suo passo, non secondo i due nomi
 * di fabbrica.
 *
 * Con `!['resolved','closed'].includes(status)` un cliente che aggiunge un
 * passo terminale suo («Annullato») vedeva il bottone su un incident concluso,
 * e uno che chiama «Sistemato» il passo di risoluzione lo vedeva su un incident
 * risolto: il contrario di quello che serve, in entrambi i versi.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { IncidentHeader } from './IncidentHeader'
import { renderWithProviders } from '@/test/utils'
import { workflowDefinitionMock, type WorkflowStepMock } from '@/test/mocks/gql'

// Workflow del CLIENTE: nomi suoi, e un passo terminale in più che il prodotto
// non conosce.
const STEPS: WorkflowStepMock[] = [
  { name: 'nuovo',       label: 'Nuovo',       category: 'active',   isInitial: true, isTerminal: false, isOpen: true },
  { name: 'in_carico',   label: 'In carico',   category: 'active',   isTerminal: false, isOpen: true },
  { name: 'sistemato',   label: 'Sistemato',   category: 'resolved', isTerminal: true,  isOpen: false },
  { name: 'archiviato',  label: 'Archiviato',  category: 'closed',   isTerminal: true,  isOpen: false },
  { name: 'annullato',   label: 'Annullato',   category: 'closed',   isTerminal: true,  isOpen: false },
]

const incident = (status: string) => ({
  id: 'inc-1', number: 'INC00000001', title: 'VPN giù', severity: 'high', status,
  workflowInstance: { id: 'wi-1', currentStep: status, status: 'active' },
  availableTransitions: [],
})

function render(status: string) {
  return renderWithProviders(
    <IncidentHeader
      incident={incident(status)}
      manualTransitions={[]}
      transitioning={false}
      onBack={vi.fn()}
      onTransitionClick={vi.fn()}
      onRequestChange={vi.fn()}
    />,
    { mocks: [workflowDefinitionMock('incident', STEPS)] },
  )
}

describe('IncidentHeader — «Richiedi Change» segue i metadata del passo', () => {
  it('passo aperto → il bottone c\'è', async () => {
    render('in_carico')
    expect(await screen.findByRole('button', { name: /Richiedi Change/ })).toBeInTheDocument()
  })

  it.each(['sistemato', 'archiviato', 'annullato'])('passo concluso «%s» (nome del cliente) → nessun bottone', async (status) => {
    const { unmount } = render(status)
    await screen.findByRole('heading', { level: 1 })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Richiedi Change/ })).not.toBeInTheDocument())
    unmount()
  })
})
