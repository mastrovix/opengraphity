/**
 * STEP 3 OF THE REPORT WIZARD: "how do you want to see it?".
 *
 * Each control here decides a piece of the query the report runs, so the
 * contracts pinned below are the ones that, broken, produce a wrong number or
 * a query that fails at execution:
 *  - the PERIOD is saved only when the group-by field is a date: a leftover
 *    "per day" on "Incidents by status" became `date(datetime(n0.status))` and
 *    Neo4j refused it;
 *  - the metric field comes from the ROOT node and only numeric fields: a field
 *    of another node is a property the root does not have — a silently wrong average;
 *  - a time series only offers date fields to group by;
 *  - Top-N/order exist only where there is a ranking (not for KPI, table, series);
 *  - a table must have at least one column, and the wizard says so.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'
import i18n from '@/i18n/i18n'
import { renderWithProviders } from '@/test/utils'
import type { NavigableField } from './ReportFlowNodes'
import { ReportChartConfig, CHART_TYPES, METRIC_TYPES, GRANULARITIES, eUnaData, periodoDaSalvare } from './ReportChartConfig'

const T = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

const f = (name: string, fieldType = 'string', label = name, labelKey: string | null = null): NavigableField =>
  ({ name, label, labelKey, fieldType, enumValues: [] })

const ROOT_FIELDS = [f('status'), f('reopen_count', 'number', 'Reopen count'), f('created_at', 'string', 'Created'), f('resolved_on', 'date', 'Resolved on')]
const TEAM_FIELDS = [f('name', 'string', 'Team name'), f('size', 'number', 'Size')]

type Props = ComponentProps<typeof ReportChartConfig>

function renderConfig(over: Partial<Props> = {}) {
  const props: Props = {
    chartType: 'bar', onChartTypeChange: vi.fn(),
    metric: 'count', onMetricChange: vi.fn(),
    metricField: '', onMetricFieldChange: vi.fn(),
    groupByNodeId: '', onGroupByNodeIdChange: vi.fn(),
    groupByField: '', onGroupByFieldChange: vi.fn(),
    groupByGranularity: '', onGroupByGranularityChange: vi.fn(),
    limit: 10, onLimitChange: vi.fn(),
    sortDir: 'DESC', onSortDirChange: vi.fn(),
    nodeDataMap: {
      n0: { label: 'Incident', fields: ROOT_FIELDS, selectedFields: [], isResult: true, isRoot: true },
      n1: { label: 'Team', fields: TEAM_FIELDS, selectedFields: [], isResult: true, isRoot: false },
      n2: { label: 'Hidden CI', fields: [f('ip')], selectedFields: [], isResult: false, isRoot: false },
    },
    onSelectedFieldsChange: vi.fn(),
    step3DateFields: [f('created_at')],
    previewLoading: false, previewData: null,
    ...over,
  }
  return { ...renderWithProviders(<ReportChartConfig {...props} />), props }
}

const nodeSelect  = () => screen.getByRole('combobox', { name: T('a11y.chartGroupByNode') }) as HTMLSelectElement
const fieldSelect = () => screen.getByRole('combobox', { name: T('a11y.chartGroupByField') }) as HTMLSelectElement
const optionValues = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.value)

describe('eUnaData / periodoDaSalvare', () => {
  it('a field is a date by its type or by its name', () => {
    expect(eUnaData({ name: 'resolved_on', fieldType: 'date' })).toBe(true)
    expect(eUnaData({ name: 'created_at' })).toBe(true)
    expect(eUnaData({ name: 'status', fieldType: null })).toBe(false)
  })

  it('the period is saved only for a date group-by, defaulting to day', () => {
    expect(periodoDaSalvare('month', 'created_at')).toBe('month')
    expect(periodoDaSalvare('', 'created_at')).toBe('day')
    expect(periodoDaSalvare('', 'resolved_on', 'datetime')).toBe('day')
    // The bug this guards: a leftover period on a non-date field.
    expect(periodoDaSalvare('day', 'status')).toBeNull()
    expect(periodoDaSalvare('day', '')).toBeNull()
  })

  it('every chart type, metric and period has a translated label', () => {
    for (const k of [...CHART_TYPES.flatMap((c) => [c.labelKey, c.descKey]), ...METRIC_TYPES.map((m) => m.labelKey), ...GRANULARITIES.map((g) => g.labelKey)]) {
      expect(T(k)).not.toBe(k)
    }
    expect(CHART_TYPES.map((c) => c.value)).toContain('top_n')
  })
})

describe('ReportChartConfig — chart type', () => {
  it('shows every type, marks the chosen one and reports a new choice', async () => {
    const { user, props } = renderConfig({ chartType: 'pie' })
    for (const ct of CHART_TYPES) expect(screen.getByRole('button', { name: new RegExp(T(ct.labelKey)) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(T('reportChart.type.pie')) })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: new RegExp(`^${T('reportChart.type.bar')}`) })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: new RegExp(T('reportChart.type.line')) }))
    expect(props.onChartTypeChange).toHaveBeenCalledWith('line')
  })
})

describe('ReportChartConfig — group by', () => {
  it('offers only the RESULT nodes, and the fields of the chosen node', async () => {
    const { user, props } = renderConfig({ groupByNodeId: 'n1' })
    expect(optionValues(nodeSelect())).toEqual(['', 'n0', 'n1'])
    expect(optionValues(fieldSelect())).toEqual(['', 'name', 'size'])
    await user.selectOptions(nodeSelect(), 'n0')
    expect(props.onGroupByNodeIdChange).toHaveBeenCalledWith('n0')
    await user.selectOptions(fieldSelect(), 'size')
    expect(props.onGroupByFieldChange).toHaveBeenCalledWith('size')
  })

  it('without a chosen node there are no fields to pick', () => {
    renderConfig()
    expect(optionValues(fieldSelect())).toEqual([''])
  })

  it('a time series only offers date fields, and warns when the query has none', () => {
    renderConfig({ chartType: 'line', groupByNodeId: 'n0', step3DateFields: [] })
    expect(optionValues(fieldSelect())).toEqual(['', 'created_at', 'resolved_on'])
    expect(screen.getByText(T('reportChart.needsDateField'))).toBeInTheDocument()
  })

  it('a time series with date fields does not warn', () => {
    renderConfig({ chartType: 'area', groupByNodeId: 'n0' })
    expect(screen.queryByText(T('reportChart.needsDateField'))).not.toBeInTheDocument()
  })

  it('a field label comes from its i18n key when the API sends one', () => {
    renderConfig({ groupByNodeId: 'n0', nodeDataMap: {
      n0: { label: 'Incident', fields: [f('title', 'string', 'Title (en)', 'common.description')], selectedFields: [], isResult: true, isRoot: true },
    } })
    expect(within(fieldSelect()).getByRole('option', { name: T('common.description') })).toBeInTheDocument()
  })

  it('KPI and table have no group-by, metric, period or ranking', () => {
    for (const chartType of ['kpi', 'table']) {
      const { unmount } = renderConfig({ chartType, groupByNodeId: 'n0', groupByField: 'created_at' })
      expect(screen.queryByRole('combobox', { name: T('a11y.chartGroupByNode') })).not.toBeInTheDocument()
      expect(screen.queryByLabelText(T('reportChart.metricLabel'))).not.toBeInTheDocument()
      expect(screen.queryByLabelText(T('reportChart.granularityLabel'))).not.toBeInTheDocument()
      expect(screen.queryByLabelText(T('reportChart.topN'))).not.toBeInTheDocument()
      unmount()
    }
  })

  it('with no result node the group-by is not shown at all', () => {
    renderConfig({ nodeDataMap: { n2: { label: 'Hidden', fields: [], selectedFields: [], isResult: false, isRoot: true } } })
    expect(screen.queryByRole('combobox', { name: T('a11y.chartGroupByNode') })).not.toBeInTheDocument()
  })
})

describe('ReportChartConfig — period', () => {
  it('appears for a bar chart grouped by a date (by name), defaulting to day, and reports a change', async () => {
    const { user, props } = renderConfig({ groupByNodeId: 'n0', groupByField: 'created_at' })
    const period = screen.getByLabelText(T('reportChart.granularityLabel')) as HTMLSelectElement
    expect(period.value).toBe('day')
    expect(optionValues(period)).toEqual(GRANULARITIES.map((g) => g.value))
    await user.selectOptions(period, 'month')
    expect(props.onGroupByGranularityChange).toHaveBeenCalledWith('month')
  })

  it('recognises a date by the metamodel type even when the name says nothing', () => {
    renderConfig({ groupByNodeId: 'n0', groupByField: 'resolved_on', groupByGranularity: 'week' })
    expect((screen.getByLabelText(T('reportChart.granularityLabel')) as HTMLSelectElement).value).toBe('week')
  })

  it('does not appear for a non-date group-by (the leftover-period bug)', () => {
    renderConfig({ groupByNodeId: 'n0', groupByField: 'status', groupByGranularity: 'day' })
    expect(screen.queryByLabelText(T('reportChart.granularityLabel'))).not.toBeInTheDocument()
  })

  it('does not appear for a field of a node that is not in the map', () => {
    renderConfig({ groupByNodeId: 'gone', groupByField: 'status' })
    expect(screen.queryByLabelText(T('reportChart.granularityLabel'))).not.toBeInTheDocument()
  })
})

describe('ReportChartConfig — metric', () => {
  it('count needs no field; changing the metric is reported', async () => {
    const { user, props } = renderConfig()
    expect(screen.queryByLabelText(T('reportChart.field'))).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText(T('reportChart.metricLabel')), 'avg')
    expect(props.onMetricChange).toHaveBeenCalledWith('avg')
  })

  it('a non-count metric offers only the NUMERIC fields of the ROOT node', async () => {
    const { user, props } = renderConfig({ metric: 'avg' })
    const metricField = screen.getByLabelText(T('reportChart.field')) as HTMLSelectElement
    // `size` is numeric but belongs to Team, not to the root: never offered.
    expect(optionValues(metricField)).toEqual(['', 'reopen_count'])
    expect(screen.queryByText(T('reportChart.noNumericField'))).not.toBeInTheDocument()
    await user.selectOptions(metricField, 'reopen_count')
    expect(props.onMetricFieldChange).toHaveBeenCalledWith('reopen_count')
  })

  it('says so when the root has no numeric field', () => {
    renderConfig({ metric: 'sum', nodeDataMap: { n0: { label: 'Incident', fields: [f('status')], selectedFields: [], isResult: true, isRoot: true } } })
    expect(screen.getByText(T('reportChart.noNumericField'))).toBeInTheDocument()
  })

  it('without a root node there is nothing to offer', () => {
    renderConfig({ metric: 'max', nodeDataMap: { n1: { label: 'Team', fields: TEAM_FIELDS, selectedFields: [], isResult: true, isRoot: false } } })
    expect(optionValues(screen.getByLabelText(T('reportChart.field')) as HTMLSelectElement)).toEqual([''])
  })
})

describe('ReportChartConfig — ranking', () => {
  it('a bar chart has Top-N and order, and reports both as typed values', async () => {
    const { user, props } = renderConfig()
    const limit = screen.getByLabelText(T('reportChart.topN'))
    // Controlled input with a fixed value: set it in one go.
    fireEvent.change(limit, { target: { value: '5' } })
    // A number, not the string of the input: the API takes an Int.
    expect(props.onLimitChange).toHaveBeenLastCalledWith(5)
    await user.selectOptions(screen.getByLabelText(T('common.order')), 'ASC')
    expect(props.onSortDirChange).toHaveBeenCalledWith('ASC')
  })

  it('a time series has no ranking: its order is the time', () => {
    renderConfig({ chartType: 'line' })
    expect(screen.queryByLabelText(T('reportChart.topN'))).not.toBeInTheDocument()
  })
})

describe('ReportChartConfig — table columns', () => {
  it('lists the fields of each result node, and asks for at least one column', () => {
    renderConfig({ chartType: 'table' })
    expect(screen.getByText(T('reportChart.needsColumn'))).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Team name' })).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'ip' })).not.toBeInTheDocument()
  })

  it('ticking adds the field, unticking removes only that one', async () => {
    const { user, props } = renderConfig({ chartType: 'table', nodeDataMap: {
      n0: { label: 'Incident', fields: ROOT_FIELDS, selectedFields: ['status', 'reopen_count'], isResult: true, isRoot: true },
    } })
    expect(screen.queryByText(T('reportChart.needsColumn'))).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Created' }))
    expect(props.onSelectedFieldsChange).toHaveBeenLastCalledWith('n0', ['status', 'reopen_count', 'created_at'])
    await user.click(screen.getByRole('checkbox', { name: 'status' }))
    expect(props.onSelectedFieldsChange).toHaveBeenLastCalledWith('n0', ['reopen_count'])
  })
})

describe('ReportChartConfig — preview', () => {
  it('shows the loading state of the preview', () => {
    renderConfig({ previewLoading: true })
    expect(screen.getByText(T('reportChart.livePreview'))).toBeInTheDocument()
    expect(screen.getByText(T('reportBuilder.loadingPreview'))).toBeInTheDocument()
  })
})
