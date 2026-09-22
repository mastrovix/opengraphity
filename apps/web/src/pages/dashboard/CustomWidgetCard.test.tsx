/**
 * A custom dashboard widget card: header (type icon, title, period chip, edit
 * controls) and a body that follows the life of the `widgetData` query.
 * What a user loses if these regress:
 *  - the spinner must give way to the numbers, and a failed query must SAY it
 *    failed (an empty card reads as "zero incidents", a false all-clear);
 *  - the period chip is the only hint that "12" means "in the last 7 days";
 *    "All" is the default and is not shown, an unknown period is shown raw;
 *  - in edit mode the two buttons must reach the dashboard's callbacks, and
 *    they must have accessible names (they are icon-only).
 * The data-free widget types (active alarms, service health) are covered in
 * ActiveAlarmsWidget.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { CustomWidgetCard, type CustomWidgetData } from './CustomWidgetCard'
import { GET_WIDGET_DATA } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

const widget = (over: Partial<CustomWidgetData> = {}): CustomWidgetData => ({
  id: 'w1', title: 'Open incidents', widgetType: 'counter', entityType: 'server', metric: 'count',
  groupByField: null, filterField: null, filterValue: null, timeRange: null, size: 'small',
  color: '#0EA5E9', position: 0, dashboardId: 'd1', ...over,
})

const dataMock = (widgetData: unknown, over: Partial<GqlMock> = {}): GqlMock => ({
  request: { query: GET_WIDGET_DATA, variables: { widgetId: 'w1' } },
  result: { data: { widgetData } },
  ...over,
})

const counterData = (value: number | null) => ({ __typename: 'WidgetData', value, label: null, series: [] })

describe('CustomWidgetCard', () => {
  it('shows a spinner while loading, then the counter with the entity type as caption', async () => {
    const { container } = renderWithProviders(<CustomWidgetCard widget={widget()} />, { mocks: [dataMock(counterData(12))] })
    expect(container.querySelector('[style*="spin"]')).not.toBeNull()
    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('server')).toBeInTheDocument()
    expect(container.querySelector('[style*="spin"]')).toBeNull()
  })

  it('with a filter the caption names the filtered value, not the entity', async () => {
    renderWithProviders(<CustomWidgetCard widget={widget({ filterField: 'status', filterValue: 'open' })} />, { mocks: [dataMock(counterData(3))] })
    expect(await screen.findByText('Status: open')).toBeInTheDocument()
    expect(screen.queryByText('server')).not.toBeInTheDocument()
  })

  it('a failed query shows the error message instead of an empty card', async () => {
    renderWithProviders(<CustomWidgetCard widget={widget()} />, {
      mocks: [dataMock(null, { result: undefined, error: new Error('widget backend down') })],
    })
    expect(await screen.findByText('widget backend down')).toBeInTheDocument()
  })

  it('a query that answers with no data says "error loading" rather than drawing nothing', async () => {
    renderWithProviders(<CustomWidgetCard widget={widget()} />, { mocks: [dataMock(null)] })
    expect(await screen.findByText('Error loading data')).toBeInTheDocument()
  })

  it('a table widget lists each series row with its value', async () => {
    const data = { __typename: 'WidgetData', value: null, label: null, series: [
      { __typename: 'WidgetSeries', label: 'high', value: 4, color: null },
      { __typename: 'WidgetSeries', label: 'low', value: 1, color: null },
    ] }
    renderWithProviders(<CustomWidgetCard widget={widget({ widgetType: 'table' })} />, { mocks: [dataMock(data)] })
    const high = await screen.findByText('high')
    expect(high.closest('tr')).toHaveTextContent('high4')
    expect(screen.getByText('low').closest('tr')).toHaveTextContent('low1')
  })

  it('the period chip: translated for a known period, raw for an unknown one, hidden for "all"', async () => {
    const { unmount } = renderWithProviders(<CustomWidgetCard widget={widget({ timeRange: '1y' })} />, { mocks: [dataMock(counterData(1))] })
    expect(await screen.findByText('1 year')).toBeInTheDocument()
    unmount()

    // A period the card does not know (added on the API first) is still shown, not dropped.
    const second = renderWithProviders(<CustomWidgetCard widget={widget({ timeRange: '6h' })} />, { mocks: [dataMock(counterData(1))] })
    expect(await screen.findByText('6h')).toBeInTheDocument()
    second.unmount()

    renderWithProviders(<CustomWidgetCard widget={widget({ timeRange: 'all' })} />, { mocks: [dataMock(counterData(1))] })
    await screen.findByText('1')
    expect(screen.queryByText('All')).not.toBeInTheDocument()
  })

  it('edit mode: named edit/remove buttons that call the dashboard back; none outside edit mode', async () => {
    const onEdit = vi.fn()
    const onRemove = vi.fn()
    const { user, unmount } = renderWithProviders(
      <CustomWidgetCard widget={widget()} editMode onEdit={onEdit} onRemove={onRemove} />,
      { mocks: [dataMock(counterData(1))] },
    )
    await user.click(screen.getByRole('button', { name: 'Edit widget' }))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onRemove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove widget' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    unmount()

    renderWithProviders(<CustomWidgetCard widget={widget()} />, { mocks: [dataMock(counterData(1))] })
    expect(screen.queryByRole('button', { name: 'Edit widget' })).not.toBeInTheDocument()
  })

  it('the card spans the grid columns of its size', () => {
    const { container } = renderWithProviders(<CustomWidgetCard widget={widget({ size: 'large' })} />, { mocks: [dataMock(counterData(1))] })
    expect(container.firstElementChild).toHaveStyle({ gridColumn: 'span 12' })
  })
})
