import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { ActiveAlarmsWidget, ACTIVE_ALARMS_WIDGET_TYPE } from './ActiveAlarmsWidget'
import { CustomWidgetCard } from './CustomWidgetCard'
import { WIDGET_TYPES, DATA_FREE_WIDGET_TYPES } from './useWidgetConfig'
import { GET_EVENT_STATS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const statsMock = (): GqlMock => ({
  request: { query: GET_EVENT_STATS },
  result: { data: { eventStats: { __typename: 'EventStats', firing: 5, critical: 2, warning: 3, orphan: 1, suppressed: 0, flapping: 0, resolved24h: 9 } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

describe('ActiveAlarmsWidget', () => {
  it('è registrato nel sistema dei widget come tipo senza configurazione dati', () => {
    expect(WIDGET_TYPES.some((w) => w.value === ACTIVE_ALARMS_WIDGET_TYPE)).toBe(true)
    expect(DATA_FREE_WIDGET_TYPES).toContain(ACTIVE_ALARMS_WIDGET_TYPE)
  })

  it('mostra i contatori di eventStats con link alla console filtrata', async () => {
    renderWithProviders(<ActiveAlarmsWidget color="#0EA5E9" />, { mocks: [statsMock()] })
    expect(await screen.findByRole('link', { name: 'Active 5' })).toHaveAttribute('href', '/events?stat=firing')
    expect(screen.getByRole('link', { name: 'Critical 2' })).toHaveAttribute('href', '/events?stat=critical')
    expect(screen.getByRole('link', { name: 'Warnings 3' })).toHaveAttribute('href', '/events?stat=warning')
    expect(screen.getByRole('link', { name: 'Orphans 1' })).toHaveAttribute('href', '/events?stat=orphan')
    expect(screen.getByRole('link', { name: 'Open the event console' })).toHaveAttribute('href', '/events')
  })

  it('errore della query → messaggio in chiaro, mai contatori finti', async () => {
    const errMock: GqlMock = { request: { query: GET_EVENT_STATS }, error: new Error('stats down'), maxUsageCount: Number.POSITIVE_INFINITY }
    renderWithProviders(<ActiveAlarmsWidget color="#0EA5E9" />, { mocks: [errMock] })
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the counters: stats down')
  })

  it('CustomWidgetCard con widgetType active_alarms usa eventStats invece di widgetData', async () => {
    const widget = {
      id: 'w1', title: 'Allarmi', widgetType: ACTIVE_ALARMS_WIDGET_TYPE, entityType: 'incident', metric: 'count',
      groupByField: null, filterField: null, filterValue: null, timeRange: null, size: 'medium', color: '#0EA5E9', position: 0, dashboardId: 'd1',
    }
    renderWithProviders(<CustomWidgetCard widget={widget} />, { mocks: [statsMock()] })
    expect(await screen.findByRole('link', { name: 'Critical 2' })).toBeInTheDocument()
    expect(screen.getByText('Allarmi')).toBeInTheDocument()
  })
})
