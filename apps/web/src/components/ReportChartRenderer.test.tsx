/**
 * ReportChartRenderer: how a computed report section is drawn.
 *
 * What a user loses if these behaviours regress:
 *  - an error from the computation must show as an error, in the viewer's
 *    language when the server sent a translation key (it used to show a raw
 *    English sentence to Italian users), and the technical message otherwise;
 *  - corrupt JSON must be named as such, not crash the whole dashboard;
 *  - every chart type the product OFFERS must be DRAWN: `top_n` fell through
 *    to "chart not available" for months while being selectable;
 *  - grouped values are shown with their Dictionary label (`valueLabel`), not
 *    the internal value;
 *  - the donut shows the total in its centre, formatted for the locale;
 *  - KPI and table sections render their data (the table with a dash for a
 *    missing cell, never "null").
 *
 * ECharts itself is replaced by a stand-in that keeps the option it receives:
 * the test reads the series the user would see, not the SVG.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { CHART_CSS_VARS, setCssVars } from '@/test/utils'
import { resetCssVarCache } from '@/lib/charts/cssVar'
import { ReportChartRenderer } from './ReportChartRenderer'

interface Series { type: string; data: unknown[]; areaStyle?: unknown }
interface Option { series: Series[]; xAxis?: { data?: string[] } | { data?: string[] }[]; yAxis?: { data?: string[] } | { data?: string[] }[]; graphic?: unknown }

const drawn: Option[] = []
vi.mock('echarts-for-react', () => ({
  default: ({ option }: { option: Option }) => {
    drawn.push(option)
    return <div data-testid="echarts" />
  },
}))

// The option builders read the theme from CSS variables, which jsdom has no stylesheet for.
let clearCssVars: () => void = () => {}
beforeAll(() => {
  resetCssVarCache()
  clearCssVars = setCssVars({
    ...CHART_CSS_VARS,
    '--color-purple-light': '#8b5cf6', '--color-teal-light': '#06b6d4', '--color-lime': '#84cc16',
    '--color-teal': '#0891b2', '--color-pink': '#ec4899', '--color-white': '#ffffff', '--color-black-a20': 'rgba(0, 0, 0, 0.20)',
  })
})
afterAll(() => { clearCssVars(); resetCssVarCache() })
beforeEach(() => { drawn.length = 0 })

const POINTS = JSON.stringify([{ name: 'high', value: 1200 }, { name: 'low', value: 34 }])

function lastOption(): Option {
  expect(drawn.length).toBeGreaterThan(0)
  return drawn[drawn.length - 1]!
}

function axisLabels(axis: Option['xAxis']): string[] | undefined {
  const a = Array.isArray(axis) ? axis[0] : axis
  return a?.data
}

describe('ReportChartRenderer — errors and missing data', () => {
  it('an error with a known key is shown translated; the technical message is not', () => {
    render(<ReportChartRenderer chartType="bar" data={POINTS} title="T" error="raw technical text" errorKey="components.reportChart.unavailable" />)
    expect(screen.getByText('Error computing the section')).toBeInTheDocument()
    expect(screen.getByText('Chart not available with the selected parameters')).toBeInTheDocument()
    expect(screen.queryByText('raw technical text')).toBeNull()
    // Even with data present, an error wins: a stale chart next to an error would be read as valid.
    expect(drawn).toHaveLength(0)
  })

  it('an error with an unknown key (or none) falls back to the message itself', () => {
    const { rerender } = render(<ReportChartRenderer chartType="bar" data="" title="T" error="neo4j: syntax error" errorKey="no.such.key" />)
    expect(screen.getByText('neo4j: syntax error')).toBeInTheDocument()
    rerender(<ReportChartRenderer chartType="bar" data="" title="T" error="plain failure" />)
    expect(screen.getByText('plain failure')).toBeInTheDocument()
  })

  it('no data: the "not available" placeholder, not an empty chart', () => {
    render(<ReportChartRenderer chartType="bar" data="" title="T" />)
    expect(screen.getByText('Chart not available with the selected parameters')).toBeInTheDocument()
    expect(drawn).toHaveLength(0)
  })

  it('corrupt JSON is named as corrupt data with the parser message', () => {
    render(<ReportChartRenderer chartType="bar" data="{not json" title="T" />)
    expect(screen.getByText('Corrupt section data')).toBeInTheDocument()
    expect(screen.queryByTestId('echarts')).toBeNull()
  })

  it('an unknown chart type shows the placeholder rather than guessing', () => {
    render(<ReportChartRenderer chartType="sankey" data={POINTS} title="T" />)
    expect(screen.getByText('Chart not available with the selected parameters')).toBeInTheDocument()
    expect(drawn).toHaveLength(0)
  })
})

describe('ReportChartRenderer — every offered chart type is drawn', () => {
  it.each([
    ['pie', 'pie'],
    ['donut', 'pie'],
    ['bar', 'bar'],
    ['bar_horizontal', 'bar'],
    ['top_n', 'bar'],
    ['line', 'line'],
    ['area', 'line'],
  ])('%s → an ECharts %s series with both points', (chartType, seriesType) => {
    render(<ReportChartRenderer chartType={chartType} data={POINTS} title="T" />)
    expect(screen.getByTestId('echarts')).toBeInTheDocument()
    const series = lastOption().series[0]!
    expect(series.type).toBe(seriesType)
    expect(series.data).toHaveLength(2)
  })

  it('top_n is a HORIZONTAL ranking: the names sit on the vertical axis', () => {
    render(<ReportChartRenderer chartType="top_n" data={POINTS} title="T" />)
    // A ranking is read by name: labels in rows (y axis), same as bar_horizontal.
    expect(axisLabels(lastOption().yAxis)).toEqual(expect.arrayContaining(['high', 'low']))
    expect(axisLabels(lastOption().xAxis)).toBeUndefined()
  })

  it('area fills under the line; line does not', () => {
    render(<ReportChartRenderer chartType="line" data={POINTS} title="T" />)
    expect(lastOption().series[0]!.areaStyle).toBeUndefined()
    render(<ReportChartRenderer chartType="area" data={POINTS} title="T" />)
    expect(lastOption().series[0]!.areaStyle).toBeDefined()
  })

  it('grouped values are shown with their Dictionary label', () => {
    const labels: Record<string, string> = { high: 'Alto', low: 'Basso' }
    render(<ReportChartRenderer chartType="bar" data={POINTS} title="T" valueLabel={(v) => labels[v] ?? v} />)
    expect(axisLabels(lastOption().xAxis)).toEqual(['Alto', 'Basso'])
  })

  it('the donut writes the total in its centre, formatted for the locale', () => {
    render(<ReportChartRenderer chartType="donut" data={POINTS} title="T" />)
    // 1200 + 34, formatted by the current language (English in tests).
    expect(JSON.stringify(lastOption().graphic)).toContain('"1,234"')
  })
})

describe('ReportChartRenderer — KPI and table', () => {
  it('KPI: the value formatted, with its own label or else the section title', () => {
    const { rerender } = render(<ReportChartRenderer chartType="kpi" data={JSON.stringify({ value: 12345, label: 'Open incidents' })} title="Section" />)
    expect(screen.getByText('12,345')).toBeInTheDocument()
    expect(screen.getByText('Open incidents')).toBeInTheDocument()
    rerender(<ReportChartRenderer chartType="kpi" data={JSON.stringify({ value: 7 })} title="Section" />)
    expect(screen.getByText('Section')).toBeInTheDocument()
  })

  it('table: columns as headers, a missing cell as a dash', () => {
    const data = JSON.stringify({ columns: ['Number', 'Owner'], rows: [['INC1', 'Anna'], ['INC2', null]] })
    render(<ReportChartRenderer chartType="table" data={data} title="T" />)
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Number', 'Owner'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([['INC1', 'Anna'], ['INC2', '—']])
  })
})

/**
 * D5 (tour of 23 Sep 2026): «Requests per month» in a half-width widget drew
 * its forty month labels on top of each other. The renderer measures the
 * width it has and the axis shows the labels that fit.
 */
describe('ReportChartRenderer — a time axis shows the labels its width holds', () => {
  const months = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2023, 8 + i, 1)).toISOString().slice(0, 10), value: i })))
  const interval = () => {
    const x = lastOption().xAxis as { axisLabel?: { interval?: number } }
    return x.axisLabel?.interval
  }

  it.each(['line', 'area', 'bar'])('%s at half width: one label in N, not all forty', (chartType) => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 450 } as DOMRect)
    render(<ReportChartRenderer chartType={chartType} data={months} title="Per month" />)
    expect(interval()).toBeGreaterThan(0)
    spy.mockRestore()
  })

  it('with room for every month, every month is shown', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 4000 } as DOMRect)
    render(<ReportChartRenderer chartType="line" data={months} title="Per month" />)
    expect(interval()).toBe(0)
    spy.mockRestore()
  })
})
