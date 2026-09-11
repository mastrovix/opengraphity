/**
 * La cronologia del workflow e l'elenco dei CI impattati si disegnavano la
 * testata da sé: nate il 2 aprile 2026 dentro le pagine, sono passate intatte
 * attraverso due giri di fattorizzazione e mostravano un colore diverso dalle
 * altre schede della stessa pagina. Ora usano `SectionCard`.
 *
 * Qui NON si pinnano i colori — quelli vivono nel test di `SectionCard`, in un
 * punto solo, ed è il punto di tutta l'operazione. Si pinna che sia la testata
 * condivisa: un pulsante vero con `aria-expanded` (prima era un div con
 * `role="button"` e la gestione a mano di Invio e Spazio) e i comandi propri
 * del riquadro che restano fuori da quel pulsante.
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { WorkflowTimeline } from './WorkflowTimeline'
import { AffectedCIList } from './AffectedCIList'

const EXEC = {
  id: 'x1', stepName: 'under_investigation', enteredAt: '2026-09-08T08:00:00Z', exitedAt: null,
  durationMs: null, triggeredBy: 'usr-1', triggerType: 'manual', notes: 'nota della voce',
}

describe('testate dei riquadri dei ticket', () => {
  it('cronologia del workflow: testata condivisa, stato aperto controllato dal chiamante', async () => {
    const { user, rerender } = renderWithProviders(
      <WorkflowTimeline historyDesc={[EXEC]} timelineOpen={false} onToggle={() => {}} />,
    )
    const toggle = screen.getByRole('button', { name: /Timeline workflow/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('nota della voce')).not.toBeInTheDocument()

    // controllato: il clic avvisa il chiamante e non apre da sé
    let toggled = 0
    rerender(<WorkflowTimeline historyDesc={[EXEC]} timelineOpen={false} onToggle={() => { toggled++ }} />)
    await user.click(screen.getByRole('button', { name: /Timeline workflow/ }))
    expect(toggled).toBe(1)
    expect(screen.getByRole('button', { name: /Timeline workflow/ })).toHaveAttribute('aria-expanded', 'false')

    rerender(<WorkflowTimeline historyDesc={[EXEC]} timelineOpen onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: /Timeline workflow/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('nota della voce')).toBeInTheDocument()
  })

  it('CI impattati: testata condivisa col conteggio, e «Aggiungi CI» fuori dal pulsante che apre', async () => {
    const ci = { id: 'ci-1', name: 'app-01', type: 'application', status: 'active', environment: 'prod' }
    const { user } = renderWithProviders(
      <AffectedCIList
        affectedCIs={[ci]}
        rules={[]}
        ciResults={[]}
        onSearchChange={() => {}}
        onAddCI={() => {}}
        onRemoveCI={() => {}}
      />,
    )
    const toggle = screen.getByRole('button', { name: /CI Impattati/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(toggle).getByText('1')).toBeInTheDocument()               // il conteggio è quello di SectionCard

    // «Aggiungi CI» non sta dentro il pulsante della testata: apre il riquadro e monta la ricerca
    const add = screen.getByRole('button', { name: '+ Aggiungi CI' })
    expect(toggle.contains(add)).toBe(false)
    await user.click(add)
    expect(screen.getByRole('button', { name: /CI Impattati/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByPlaceholderText(/Cerca CI/)).toBeInTheDocument()
  })
})
