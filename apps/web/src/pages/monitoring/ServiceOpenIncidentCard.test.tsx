/**
 * Riquadro «Incident aperto» del dettaglio servizio (ondata 3): la riga con
 * numero, titolo, passo e link; la nota quando le regole non aprono incident
 * (`openIncidentFrom: never`); «nessun incident» negli altri casi; il passo
 * dichiarato mancante invece che inventato.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { ServiceOpenIncidentCard } from './ServiceOpenIncidentCard'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { workflowDefinitionMock } from '@/test/mocks/gql'
import { openIncident } from '@/test/mocks/services'
import type { ServiceOpenIncident } from '@/types/services'

const render = (incident: ServiceOpenIncident | null, openIncidentFrom = 'down', mocks: GqlMock[] = [workflowDefinitionMock()]) =>
  renderWithProviders(<ServiceOpenIncidentCard incident={incident} openIncidentFrom={openIncidentFrom} />, { mocks })

const asIncident = (over: Record<string, unknown> = {}) => openIncident(over) as unknown as ServiceOpenIncident

describe('ServiceOpenIncidentCard', () => {
  it('C-12: stato e passo con l\'etichetta del workflow dell\'app, non «in progress» tradotto a mano', async () => {
    render(asIncident())
    expect(screen.getByText('Open incident')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'INC-0042' })
    expect(link).toHaveAttribute('href', '/incidents/inc-1')
    expect(link).toHaveAttribute('title', 'Open incident INC-0042')
    expect(screen.getByText('Servizio Enterprise Billing: degradato')).toBeInTheDocument()
    expect(await screen.findByText('In lavorazione')).toBeInTheDocument()        // stato = etichetta del passo
    expect(await screen.findByText('Step: In lavorazione')).toBeInTheDocument()
    expect(screen.queryByText('in progress')).not.toBeInTheDocument()
  })

  it('C-12: un passo che non è nel workflow è detto in chiaro, mai un\'etichetta inventata', async () => {
    render(asIncident({ status: 'zombie', workflowInstance: { __typename: 'WorkflowInstance', id: 'wi-1', currentStep: 'zombie', status: 'active' } }))
    expect(await screen.findByText('Unknown (zombie)')).toBeInTheDocument()
    expect(screen.getByText('Step: Unknown (zombie)')).toBeInTheDocument()
  })

  it('C-12: definizione del workflow non caricata → valori grezzi e il motivo accanto', async () => {
    const failing: GqlMock = { request: { query: workflowDefinitionMock().request.query, variables: { entityType: 'incident' } }, error: new Error('workflow down') }
    render(asIncident(), 'down', [failing])
    const alert = await screen.findByTestId('open-incident-steps-error')
    expect(alert).toHaveTextContent('Workflow labels not loaded (workflow down): status and step are the raw values.')
    expect(screen.getByText('Unknown (in_progress)')).toBeInTheDocument()
  })

  it('incident senza istanza di workflow: il passo è dichiarato mancante, non inventato', () => {
    render(asIncident({ workflowInstance: null }))
    expect(screen.getByText('Step not available')).toBeInTheDocument()
    expect(screen.queryByText(/^Step: /)).not.toBeInTheDocument()
  })

  it('nessun incident e soglia «never»: la nota dice che gli incident sono disattivati', () => {
    render(null, 'never')
    expect(screen.getByText('Incidents are turned off for this service.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('nessun incident con la soglia attiva: «nessun incident aperto», non la nota dei disattivati', () => {
    render(null, 'degraded')
    expect(screen.getByText('No open incident for this service.')).toBeInTheDocument()
    expect(screen.queryByText('Incidents are turned off for this service.')).not.toBeInTheDocument()
  })
})
