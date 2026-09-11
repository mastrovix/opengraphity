/**
 * Banner dei servizi critici giù in testa alla console allarmi (ondata 3):
 * compare solo se almeno un servizio `mission_critical`/`business_critical` è
 * giù, con il link a ciascun servizio e alla lista filtrata; NON compare se i
 * servizi giù non sono critici o se non ce n'è nessuno; un errore della query
 * resta visibile invece di diventare «va tutto bene».
 *
 * Revisione 2 (C-7): la criticità è un filtro del SERVER — il mock qui sotto
 * lo applica come farebbe l'API, così il caso «21 servizi giù, l'unico critico
 * oltre il limite» misura davvero ciò che cambia: prima si leggevano le prime
 * venti righe e si scartava la criticità a valle, e il banner taceva.
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { useQuery } from '@apollo/client/react'
import { CriticalServicesBanner, CRITICAL_CRITICALITIES, CRITICAL_SERVICES_PATH } from './CriticalServicesBanner'
import { GET_SERVICE_MAPS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { COUNTS, mapRow, SERVICE } from '@/test/mocks/services'
import type { ServiceMapPage } from '@/types/services'

/**
 * `serviceMaps` come lo serve l'API al banner: applica `criticality` e
 * `limit`, e `total` conta TUTTE le righe che superano il filtro (non solo
 * quelle restituite).
 */
function serverMock(items: Record<string, unknown>[] = []): GqlMock {
  return {
    request: { query: GET_SERVICE_MAPS, variables: () => true },
    result: (variables: Record<string, unknown>) => {
      const filter = (variables['filter'] ?? {}) as { criticality?: string[] }
      const limit = Number(variables['limit'] ?? 20)
      const wanted = filter.criticality
      const matching = wanted
        ? items.filter((s) => wanted.includes(String((s['service'] as { criticality: string | null }).criticality ?? '')))
        : items
      return { data: { serviceMaps: { __typename: 'ServiceMapPage', total: matching.length, counts: COUNTS, items: matching.slice(0, limit) } } }
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

/**
 * Sonda sulla stessa query: dà ai casi «nessun banner» un punto d'attesa
 * reale (i dati SONO arrivati), invece di verificare un'assenza che sarebbe
 * vera anche solo perché la risposta non è ancora tornata.
 */
function Probe() {
  const { data } = useQuery<{ serviceMaps: ServiceMapPage }>(GET_SERVICE_MAPS, { variables: { filter: { health: ['down'], status: 'active', criticality: [...CRITICAL_CRITICALITIES] }, limit: 20, offset: 0 } })
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

/** 20 servizi giù ma NON critici: da soli riempiono la pagina che il banner legge. */
const twentyNonCritical = Array.from({ length: 20 }, (_, i) => mapRow({
  id: `map-nc-${i}`, name: `Intranet ${i}`, health: 'down', impactScore: 100,
  service: { ...SERVICE, id: `ba-nc-${i}`, name: `Intranet ${i}`, criticality: 'office_productivity' },
}))

const render = (mock: GqlMock) => renderWithProviders(<><CriticalServicesBanner /><Probe /></>, { mocks: [mock] })

describe('CriticalServicesBanner', () => {
  it('un servizio critico giù: banner con la riga del servizio (link) e il rimando alla lista filtrata', async () => {
    render(serverMock([criticalDown]))
    const banner = await screen.findByTestId('critical-services-banner')
    expect(banner).toHaveTextContent('A critical service is down')
    expect(within(banner).getByRole('link', { name: 'Enterprise Billing' })).toHaveAttribute('href', '/monitoring/services/map-1')
    expect(banner).toHaveTextContent('is down (Business Critical).')
    expect(within(banner).getByRole('link', { name: /Down services/ })).toHaveAttribute('href', CRITICAL_SERVICES_PATH)
  })

  it('più servizi critici: il titolo li conta e ogni riga ha il suo link', async () => {
    render(serverMock([criticalDown, missionDown]))
    const banner = await screen.findByTestId('critical-services-banner')
    expect(banner).toHaveTextContent('2 critical services are down')
    expect(within(banner).getByRole('link', { name: 'Payroll' })).toHaveAttribute('href', '/monitoring/services/map-2')
    expect(banner).toHaveTextContent('is down (Mission Critical).')
  })

  it('nessun servizio critico giù (solo servizi non critici o senza criticità): nessun banner', async () => {
    render(serverMock([officeDown, noCriticalityDown]))
    // I dati SONO arrivati (la sonda li ha visti): l'assenza del banner è una scelta, non un'attesa.
    expect(await screen.findByTestId('probe')).toHaveTextContent('rows:0')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })

  it('nessun servizio giù: nessun banner', async () => {
    render(serverMock())
    expect(await screen.findByTestId('probe')).toHaveTextContent('rows:0')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })

  // C-7: il caso che prima falliva. Con la criticità filtrata a valle, i venti
  // servizi non critici riempivano la pagina letta e il ventunesimo — l'unico
  // critico — non ci entrava: nessuna riga «critica», nessun banner.
  it('21 servizi giù di cui solo l\'ultimo critico: il banner compare lo stesso (filtro del server)', async () => {
    render(serverMock([...twentyNonCritical, missionDown]))
    const banner = await screen.findByTestId('critical-services-banner')
    expect(banner).toHaveTextContent('A critical service is down')
    expect(within(banner).getByRole('link', { name: 'Payroll' })).toHaveAttribute('href', '/monitoring/services/map-2')
    // I venti non critici non sono nemmeno arrivati: il server li ha scartati.
    expect(screen.getByTestId('probe')).toHaveTextContent('rows:1')
  })

  it('più servizi critici del limite: l\'elenco è parziale ma il titolo conta il totale del server', async () => {
    const many = Array.from({ length: 22 }, (_, i) => mapRow({
      id: `map-c-${i}`, name: `Billing ${i}`, health: 'down', impactScore: 100,
      service: { ...SERVICE, id: `ba-c-${i}`, name: `Billing ${i}`, criticality: 'business_critical' },
    }))
    render(serverMock(many))
    const banner = await screen.findByTestId('critical-services-banner')
    expect(banner).toHaveTextContent('22 critical services are down')
    expect(within(banner).getAllByRole('link', { name: /^Billing / })).toHaveLength(20)
  })

  it('errore della query: messaggio visibile con la chiave del banner, mai un silenzio che sembra «tutto bene»', async () => {
    const failing: GqlMock = { request: { query: GET_SERVICE_MAPS, variables: () => true }, error: new Error('services down'), maxUsageCount: Number.POSITIVE_INFINITY }
    render(failing)
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot tell whether a critical service is down: services down')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })
})
