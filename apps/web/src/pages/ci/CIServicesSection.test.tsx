/**
 * «Servizi che dipendono da questo CI»: assente senza servizi, righe con
 * badge di salute, punteggio e link al dettaglio, errore visibile (mai
 * «nessun servizio» al posto di un errore).
 */
import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { CIServicesSection } from './CIServicesSection'
import { GET_SERVICES_IMPACTED_BY_CI } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapRow } from '@/test/mocks/services'

const servicesMock = (items: Record<string, unknown>[]): GqlMock => ({
  request: { query: GET_SERVICES_IMPACTED_BY_CI, variables: { ciId: 'db-01' } },
  result: { data: { servicesImpactedByCI: items } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('CIServicesSection', () => {
  it('nessun servizio → la sezione non compare', async () => {
    renderWithProviders(<CIServicesSection ciId="db-01" />, { mocks: [servicesMock([])] })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: /Services depending on this CI/ })).not.toBeInTheDocument()
  })

  it('servizi presenti → sezione con conteggio, link, salute, punteggio, causa principale e icona «stale»', async () => {
    renderWithProviders(<CIServicesSection ciId="db-01" />, { mocks: [servicesMock([mapRow(), mapRow({ id: 'map-2', name: 'Payroll', health: 'down', impactScore: 100, stale: true })])] })
    expect(await screen.findByRole('button', { name: /Services depending on this CI/ })).toHaveTextContent('2')
    const rows = screen.getAllByTestId('ci-service-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('link', { name: 'Enterprise Billing' })).toHaveAttribute('href', '/monitoring/services/map-1')
    expect(within(rows[0]!).getByText('Degraded')).toBeInTheDocument()
    expect(within(rows[0]!).getByLabelText('Impact score 41 out of 100')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('db-01 down via api-03')).toBeInTheDocument()
    expect(within(rows[1]!).getByRole('img', { name: 'Component missing from the CMDB' })).toBeInTheDocument()
  })

  it('errore della query → QueryError visibile con Riprova', async () => {
    const failing: GqlMock = { request: { query: GET_SERVICES_IMPACTED_BY_CI, variables: { ciId: 'db-01' } }, error: new Error('services down'), maxUsageCount: Number.POSITIVE_INFINITY }
    renderWithProviders(<CIServicesSection ciId="db-01" />, { mocks: [failing] })
    expect(await screen.findByText('services down')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument())
  })
})
