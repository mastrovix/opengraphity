/**
 * Banner dei servizi critici giù in testa alla console allarmi (ondata 3):
 * compare solo se almeno un servizio `mission_critical`/`business_critical` è
 * giù, con il link a ciascun servizio e alla lista filtrata; NON compare se i
 * servizi giù non sono critici o se non ce n'è nessuno; un errore della query
 * resta visibile invece di diventare «va tutto bene».
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { useQuery } from '@apollo/client/react'
import { CriticalServicesBanner, CRITICAL_SERVICES_PATH } from './CriticalServicesBanner'
import { GET_SERVICE_MAPS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapRow, serviceMapsMock, SERVICE } from '@/test/mocks/services'
import type { ServiceMapPage } from '@/types/services'

/**
 * Sonda sulla stessa query: dà ai casi «nessun banner» un punto d'attesa
 * reale (i dati SONO arrivati), invece di verificare un'assenza che sarebbe
 * vera anche solo perché la risposta non è ancora tornata.
 */
function Probe() {
  const { data } = useQuery<{ serviceMaps: ServiceMapPage }>(GET_SERVICE_MAPS, { variables: { filter: { health: ['down'], status: 'active' }, limit: 20, offset: 0 } })
  return <span data-testid="probe">{data ? `rows:${data.serviceMaps.items.length}` : '…'}</span>
}

const criticalDown = mapRow({ id: 'map-1', name: 'Enterprise Billing', health: 'down', impactScore: 100 })
const missionDown = mapRow({
  id: 'map-2', name: 'Payroll', health: 'down', impactScore: 100,
  service: { ...SERVICE, id: 'ba-2', name: 'Payroll', criticality: 'mission_critical' },
})
const officeDown = mapRow({
  id: 'map-3', name: 'Intranet', health: 'down', impactScore: 100,
  service: { ...SERVICE, id: 'ba-3', name: 'Intranet', criticality: 'office_productivity' },
})
const noCriticalityDown = mapRow({
  id: 'map-4', name: 'Wiki', health: 'down', impactScore: 100,
  service: { ...SERVICE, id: 'ba-4', name: 'Wiki', criticality: null },
})

const render = (mock: GqlMock) => renderWithProviders(<><CriticalServicesBanner /><Probe /></>, { mocks: [mock] })

describe('CriticalServicesBanner', () => {
  it('un servizio critico giù: banner con la riga del servizio (link) e il rimando alla lista filtrata', async () => {
    render(serviceMapsMock([criticalDown]))
    const banner = await screen.findByTestId('critical-services-banner')
    expect(banner).toHaveTextContent('A critical service is down')
    expect(within(banner).getByRole('link', { name: 'Enterprise Billing' })).toHaveAttribute('href', '/monitoring/services/map-1')
    expect(banner).toHaveTextContent('is down (Business Critical).')
    expect(within(banner).getByRole('link', { name: /Down services/ })).toHaveAttribute('href', CRITICAL_SERVICES_PATH)
  })

  it('più servizi critici: il titolo li conta e ogni riga ha il suo link', async () => {
    render(serviceMapsMock([criticalDown, missionDown]))
    const banner = await screen.findByTestId('critical-services-banner')
    expect(banner).toHaveTextContent('2 critical services are down')
    expect(within(banner).getByRole('link', { name: 'Payroll' })).toHaveAttribute('href', '/monitoring/services/map-2')
    expect(banner).toHaveTextContent('is down (Mission Critical).')
  })

  it('nessun servizio critico giù (solo servizi non critici o senza criticità): nessun banner', async () => {
    render(serviceMapsMock([officeDown, noCriticalityDown]))
    // I dati SONO arrivati (la sonda li ha visti): l'assenza del banner è una scelta, non un'attesa.
    expect(await screen.findByTestId('probe')).toHaveTextContent('rows:2')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })

  it('nessun servizio giù: nessun banner', async () => {
    render(serviceMapsMock())
    expect(await screen.findByTestId('probe')).toHaveTextContent('rows:0')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })

  it('errore della query: messaggio visibile, mai un silenzio che sembra «tutto bene»', async () => {
    const failing: GqlMock = { request: { query: GET_SERVICE_MAPS, variables: () => true }, error: new Error('services down'), maxUsageCount: Number.POSITIVE_INFINITY }
    render(failing)
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the counters: services down')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })
})
