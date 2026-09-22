/**
 * WidgetBody is the ONE renderer shared by the real dashboard card and the
 * configurator preview. If it regresses, what an admin sees while configuring
 * a widget stops matching what lands on the dashboard (the defect this
 * component was created to close), or a counter/table shows a wrong number.
 *
 * ECharts itself is replaced by a stub that exposes the option it receives:
 * the contract under test is WHICH chart is built from the data, not how
 * ECharts draws it.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CHART_CSS_VARS, setCssVars } from '@/test/utils'
import { resetCssVarCache } from '@/lib/charts/cssVar'
import { WidgetBody, type WidgetSeriesData } from './WidgetBody'

vi.mock('echarts-for-react', () => ({
  default: ({ option, style }: { option: unknown; style: { height: number } }) => (
    <div data-testid="chart" data-height={style.height}>{JSON.stringify(option)}</div>
  ),
}))

const data = (over: Partial<WidgetSeriesData> = {}): WidgetSeriesData => ({
  value: null, label: null,
  series: [{ label: 'open', value: 1200 }, { label: 'closed', value: 3 }],
  ...over,
})

const chartOption = () => JSON.parse(screen.getByTestId('chart').textContent ?? '{}') as {
  series: Array<{ type: string; radius?: unknown; data: unknown[] }>
}

describe('WidgetBody — counter', () => {
  it('rounds the value and shows the caption', () => {
    render(<WidgetBody widgetType="counter" color="red" data={data({ value: 41.6 })} caption="Status: open" />)
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('Status: open')).toBeInTheDocument()
  })

  it('shows a dash, not 0, when there is no value (0 would be a false reading)', () => {
    render(<WidgetBody widgetType="counter" color="red" data={data({ value: null })} large />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })
})

describe('WidgetBody — table', () => {
  it('lists every series row with its value', () => {
    render(<WidgetBody widgetType="table" color="blue" data={data()} />)
    const rows = screen.getAllByRole('row')
    // header + two data rows
    expect(rows).toHaveLength(3)
    expect(rows[1]).toHaveTextContent('open')
    expect(rows[1]).toHaveTextContent('1,200')
    expect(rows[2]).toHaveTextContent('closed')
  })

  it('says there is no data instead of an empty table', () => {
    render(<WidgetBody widgetType="table" color="blue" data={data({ series: [] })} />)
    expect(screen.getByText('No data')).toBeInTheDocument()
  })
})

describe('WidgetBody — charts', () => {
  // The chart builders read the design tokens from :root and fail loudly without them.
  let cleanup: () => void
  beforeAll(() => { resetCssVarCache(); cleanup = setCssVars({
    ...CHART_CSS_VARS,
    '--color-purple-light': '#8b5cf6', '--color-teal-light': '#06b6d4', '--color-lime': '#84cc16',
    '--color-teal': '#0891b2', '--color-pink': '#ec4899', '--color-white': '#ffffff', '--color-black-a20': 'rgba(0, 0, 0, 0.20)',
  }) })
  afterAll(() => { cleanup(); resetCssVarCache() })
  afterEach(() => { vi.restoreAllMocks() })

  it.each([
    ['chart_bar', 'bar'],
    ['chart_line', 'line'],
    ['chart_pie', 'pie'],
  ])('%s builds a %s series from the widget points', (widgetType, type) => {
    render(<WidgetBody widgetType={widgetType} color="green" data={data()} height={200} />)
    const opt = chartOption()
    expect(opt.series[0]!.type).toBe(type)
    expect(opt.series[0]!.data).toHaveLength(2)
    expect(screen.getByTestId('chart')).toHaveAttribute('data-height', '200')
  })

  it('a donut is a pie with a hole (a ring radius), a pie is not', () => {
    render(<WidgetBody widgetType="chart_donut" color="green" data={data()} />)
    const radius = chartOption().series[0]!.radius
    expect(Array.isArray(radius)).toBe(true)
    expect((radius as string[])[0]).not.toBe('0%')
  })

  it('a gauge reads the single value, and its height is capped so it does not stretch', () => {
    render(<WidgetBody widgetType="gauge" color="green" data={data({ value: 70 })} height={300} />)
    const opt = chartOption()
    expect(opt.series[0]!.type).toBe('gauge')
    expect(opt.series[0]!.data).toEqual([{ value: 70 }])
    expect(screen.getByTestId('chart')).toHaveAttribute('data-height', '160')
  })

  it('an unknown widget type is reported loudly and falls back to a bar chart', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<WidgetBody widgetType="chart_radar" color="green" data={data()} />)
    expect(chartOption().series[0]!.type).toBe('bar')
    // No silent fallback: the unknown value is named in the console.
    expect(err).toHaveBeenCalledWith(expect.stringContaining('chart_radar'))
  })
})
