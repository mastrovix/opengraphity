/**
 * Sezione «Capacità di business» in fondo alla pagina Servizi (ondata 3, sola
 * lettura): nome, salute peggiore, quanti servizi giù/degradati, servizi come
 * link; nessun controllo di modifica; stato vuoto ed errore detti in chiaro.
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { BusinessCapabilitiesSection } from './BusinessCapabilitiesSection'
import { GET_BUSINESS_CAPABILITIES_HEALTH } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { capability, SERVICE } from '@/test/mocks/services'

const capabilitiesMock = (items: Record<string, unknown>[]): GqlMock => ({
  request: { query: GET_BUSINESS_CAPABILITIES_HEALTH },
  result: { data: { businessCapabilitiesHealth: items } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const CAPS = [
  capability(),
  capability({
    id: 'cap-2', name: 'Paghe', health: 'down', downServices: 2, degradedServices: 0,
    services: [SERVICE, { ...SERVICE, id: 'ba-2', name: 'Payroll' }],
  }),
  capability({ id: 'cap-3', name: 'Intranet', health: 'unknown', downServices: 0, degradedServices: 0, services: [] }),
]

const render = (mock: GqlMock) => renderWithProviders(<BusinessCapabilitiesSection />, { mocks: [mock] })
const rows = () => screen.getAllByTestId('capability-row')

describe('BusinessCapabilitiesSection', () => {
  it('una riga per capacità: salute peggiore, servizi giù/degradati e servizi collegati come link', async () => {
    render(capabilitiesMock(CAPS))
    expect(await screen.findByRole('table', { name: 'Business capabilities' })).toBeInTheDocument()
    expect(rows()).toHaveLength(3)

    expect(within(rows()[0]!).getByText('Degraded')).toBeInTheDocument()
    expect(within(rows()[0]!).getByText('1 degraded')).toBeInTheDocument()
    expect(within(rows()[0]!).getByRole('link', { name: 'Enterprise Billing' })).toHaveAttribute('href', '/monitoring/services?q=Enterprise%20Billing')

    expect(within(rows()[1]!).getByText('Down')).toBeInTheDocument()
    expect(within(rows()[1]!).getByText('2 down')).toBeInTheDocument()
    expect(within(rows()[1]!).getByRole('link', { name: 'Payroll' })).toHaveAttribute('href', '/monitoring/services?q=Payroll')

    // Nessun servizio con salute nota → «Sconosciuta», niente contatori inventati
    expect(within(rows()[2]!).getByText('Unknown')).toBeInTheDocument()
    expect(within(rows()[2]!).getByText('No linked service')).toBeInTheDocument()

    // Sola lettura: nessun controllo di modifica dentro la sezione
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('nessuna capacità: lo dice, non resta un riquadro muto', async () => {
    render(capabilitiesMock([]))
    expect(await screen.findByText('No business capability linked to a service.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('errore della query: messaggio del server con Riprova, mai «nessuna capacità»', async () => {
    const failing: GqlMock = { request: { query: GET_BUSINESS_CAPABILITIES_HEALTH }, error: new Error('capabilities down'), maxUsageCount: Number.POSITIVE_INFINITY }
    render(failing)
    expect(await screen.findByText('Cannot load business capabilities: capabilities down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
    expect(screen.queryByText('No business capability linked to a service.')).not.toBeInTheDocument()
  })
})
