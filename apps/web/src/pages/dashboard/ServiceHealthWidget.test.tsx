/**
 * Widget «Salute dei servizi» (ondata 3): registrato come tipo senza
 * configurazione dati, quattro contatori cliccabili verso la pagina Servizi
 * filtrata, errore in chiaro, e per i non-staff il messaggio invece di link a
 * una pagina «accesso negato».
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { ServiceHealthWidget, SERVICE_HEALTH_WIDGET_TYPE } from './ServiceHealthWidget'
import { CustomWidgetCard } from './CustomWidgetCard'
import { WIDGET_TYPES, DATA_FREE_WIDGET_TYPES, DATA_FREE_HINT_KEY } from './useWidgetConfig'
import { GET_SERVICE_HEALTH_COUNTS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'

const countsMock = (): GqlMock => ({
  request: { query: GET_SERVICE_HEALTH_COUNTS },
  result: { data: { serviceMaps: { __typename: 'ServiceMapPage', counts: { __typename: 'ServiceMapCounts', total: 9, operational: 5, degraded: 2, down: 1, maintenance: 1, unknown: 0 } } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

/** Colore del widget: è un dato scelto dall'utente, non un token (vedi presetColors). */
const WIDGET_COLOR = '#0EA5E9'

describe('ServiceHealthWidget', () => {
  it('è registrato nel sistema dei widget come tipo senza configurazione dati, con il suo aiuto', () => {
    expect(WIDGET_TYPES.some((w) => w.value === SERVICE_HEALTH_WIDGET_TYPE)).toBe(true)
    expect(DATA_FREE_WIDGET_TYPES).toContain(SERVICE_HEALTH_WIDGET_TYPE)
    expect(DATA_FREE_HINT_KEY[SERVICE_HEALTH_WIDGET_TYPE]).toBe('pages.dashboard.serviceHealthHint')
  })

  it('quattro contatori con link alla pagina Servizi filtrata per salute', async () => {
    renderWithProviders(<ServiceHealthWidget color={WIDGET_COLOR} />, { mocks: [meMock('operator'), countsMock()] })
    expect(await screen.findByRole('link', { name: 'Down 1' })).toHaveAttribute('href', '/monitoring/services?health=down')
    expect(screen.getByRole('link', { name: 'Degraded 2' })).toHaveAttribute('href', '/monitoring/services?health=degraded')
    expect(screen.getByRole('link', { name: 'In maintenance 1' })).toHaveAttribute('href', '/monitoring/services?health=maintenance')
    expect(screen.getByRole('link', { name: 'Operational 5' })).toHaveAttribute('href', '/monitoring/services?health=operational')
    expect(screen.getByRole('link', { name: 'Open the Services page' })).toHaveAttribute('href', '/monitoring/services')
  })

  it('errore della query → messaggio in chiaro, mai contatori finti', async () => {
    const errMock: GqlMock = { request: { query: GET_SERVICE_HEALTH_COUNTS }, error: new Error('services down'), maxUsageCount: Number.POSITIVE_INFINITY }
    renderWithProviders(<ServiceHealthWidget color={WIDGET_COLOR} />, { mocks: [meMock('viewer'), errMock] })
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the counters: services down')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('end user: nessun contatore né link (la pagina Servizi è riservata allo staff), ma un messaggio in chiaro', async () => {
    renderWithProviders(<ServiceHealthWidget color={WIDGET_COLOR} />, { mocks: [meMock('end_user'), countsMock()] })
    expect(await screen.findByText(/reserved to staff/)).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('CustomWidgetCard con widgetType service_health legge i contatori dei servizi invece di widgetData', async () => {
    const widget = {
      id: 'w2', title: 'Servizi', widgetType: SERVICE_HEALTH_WIDGET_TYPE, entityType: 'incident', metric: 'count',
      groupByField: null, filterField: null, filterValue: null, timeRange: null, size: 'medium', color: WIDGET_COLOR, position: 0, dashboardId: 'd1',
    }
    renderWithProviders(<CustomWidgetCard widget={widget} />, { mocks: [meMock('operator'), countsMock()] })
    expect(await screen.findByRole('link', { name: 'Down 1' })).toBeInTheDocument()
    expect(screen.getByText('Servizi')).toBeInTheDocument()
  })
})
