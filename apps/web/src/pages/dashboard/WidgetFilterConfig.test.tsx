/**
 * THE DATA OPTIONS of a custom dashboard widget: entity, metric, grouping,
 * filter, period, size and colour.
 *
 * Each choice here decides what the widget counts, for everyone who looks at
 * the dashboard. The behaviours pinned:
 *  - the entities are the customer's own ticket and CI types, in two groups,
 *    each under the customer's label (a renamed type must not show its
 *    factory name) — and before the catalogue arrives the saved entity is
 *    still there, not silently replaced by the first option;
 *  - the field to group by is asked only for a metric that needs one; when
 *    the type has no suitable field the panel SAYS why, instead of offering
 *    an empty list;
 *  - the filter value gets the control its field needs (Dictionary labels
 *    for an enum, Yes/No for a boolean, a date, a number, free text) and is
 *    disabled until a field is chosen;
 *  - period, size and colour are buttons whose chosen state is announced;
 *  - a widget with a fixed data source keeps only size and colour.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { renderWithProviders, setCssVars } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'
import { resetCssVarCache } from '@/lib/charts/cssVar'
import { WidgetFilterConfig } from './WidgetFilterConfig'
import type { FieldMeta, WidgetCatalogEntity } from './useWidgetConfig'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

// The preset colours are read from the theme tokens (jsdom has no stylesheet).
let clearCssVars: () => void = () => {}
beforeAll(() => {
  resetCssVarCache()
  clearCssVars = setCssVars({
    '--color-brand': '#0284c7', '--color-success': '#16a34a', '--color-danger': '#ef4444',
    '--color-warning': '#eab308', '--color-purple-light': '#8b5cf6', '--color-slate': '#64748b',
  })
})
afterAll(() => { clearCssVars(); resetCssVarCache() })

beforeEach(() => {
  apolloFinto.reset()
  // The customer renamed "incident"; "problem" has no label of its own.
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Disruption', fields: [] }, { name: 'problem', label: null, fields: [] }] }
})

const field = (name: string, over: Partial<FieldMeta> = {}): FieldMeta => ({
  name, label: name, fieldType: 'string', enumValues: [], enumTypeName: null, groupable: true, numeric: false, custom: false, ...over,
})

const ENTITIES: WidgetCatalogEntity[] = [
  { entityType: 'incident', label: 'Incident', group: 'itsm', fields: [] },
  { entityType: 'problem', label: 'Problem', group: 'itsm', fields: [] },
  { entityType: 'server', label: 'Server', group: 'cmdb', fields: [] },
  { entityType: 'firewall', label: 'Firewall', group: 'cmdb', fields: [] },
]

type Props = ComponentProps<typeof WidgetFilterConfig>

function config(over: Partial<Props> = {}) {
  const props: Props = {
    entityType: 'incident', onEntityChange: vi.fn(), metric: 'count', onMetricChange: vi.fn(),
    groupByField: '', onGroupByChange: vi.fn(), filterField: '', onFilterFieldChange: vi.fn(),
    filterValue: '', onFilterValueChange: vi.fn(), timeRange: 'all', onTimeRangeChange: vi.fn(),
    size: 'medium', onSizeChange: vi.fn(), color: '#0284c7', onColorChange: vi.fn(),
    entities: ENTITIES, groupByFields: [], filterFields: [], needsGroupBy: false, fieldMetaMap: {}, selectedFilterMeta: null,
    ...over,
  }
  // "firewall" is a CI type the customer created.
  const r = renderWithProviders(withVocabularyLabels(<WidgetFilterConfig {...props} />), { ciTypes: [['firewall', 'Perimeter firewall']] })
  return { ...r, props }
}

const options = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent)

describe('WidgetFilterConfig — entity and metric', () => {
  it("groups the customer's ticket types and CI types, each under the customer's own name", async () => {
    const { user, props } = config()
    const entity = screen.getByRole('combobox', { name: 'Entity' })
    expect(options(within(entity).getByRole('group', { name: 'Tickets' }))).toEqual(['Disruption', 'problem'])
    expect(options(within(entity).getByRole('group', { name: 'CMDB' }))).toEqual(['Server', 'Perimeter firewall'])
    await user.selectOptions(entity, 'Perimeter firewall')
    expect(props.onEntityChange).toHaveBeenCalledWith('firewall')
  })

  it('a catalogue with only CI types shows no empty ticket group', () => {
    config({ entities: [ENTITIES[2]!], entityType: 'server' })
    const entity = screen.getByRole('combobox', { name: 'Entity' })
    expect(within(entity).queryByRole('group', { name: 'Tickets' })).toBeNull()
    expect(options(entity)).toEqual(['Server'])
  })

  it('before the catalogue arrives, the saved entity is kept as the only choice', () => {
    config({ entities: [], entityType: 'change' })
    const entity = screen.getByRole('combobox', { name: 'Entity' })
    expect(options(entity)).toEqual(['change'])
    expect(entity).toHaveValue('change')
  })

  it('offers the four metrics and reports the chosen one', async () => {
    const { user, props } = config()
    const metric = screen.getByRole('combobox', { name: 'Metric' })
    expect(options(metric)).toEqual(['Count', 'Count by field', 'Field average', 'Field sum'])
    await user.selectOptions(metric, 'Field sum')
    expect(props.onMetricChange).toHaveBeenCalledWith('sum_field')
  })
})

describe('WidgetFilterConfig — group by', () => {
  it('is asked only for a metric that needs a field', () => {
    config({ needsGroupBy: false, groupByFields: [field('priority')] })
    expect(screen.queryByRole('combobox', { name: 'Group by field' })).toBeNull()
  })

  it('names each field by its label and type, and reports the chosen one', async () => {
    const priority = field('priority', { label: 'Priority', fieldType: 'enum' })
    const cost = field('cost', { label: 'Cost', fieldType: 'currency' })
    // A label the API did not send: the field is named by its name.
    const site = field('site', { label: null as unknown as string })
    const { user, props } = config({
      needsGroupBy: true, metric: 'count_by_field',
      groupByFields: [priority, cost, site, field('legacy_code')],
      fieldMetaMap: { priority, cost, site },
    })
    const groupBy = screen.getByRole('combobox', { name: 'Group by field' })
    // A known type is translated, an unknown one shown as it is, a field without metadata by its name.
    expect(options(groupBy)).toEqual(['-- Select field --', 'Priority (enum)', 'Cost (currency)', 'site (text)', 'legacy_code'])
    await user.selectOptions(groupBy, 'Priority (enum)')
    expect(props.onGroupByChange).toHaveBeenCalledWith('priority')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('with no suitable field it says why: nothing to group for a count, nothing numeric for an average', () => {
    const { unmount } = config({ needsGroupBy: true, metric: 'count_by_field', groupByFields: [] })
    expect(screen.getByRole('note')).toHaveTextContent('This type has no field to group by.')
    unmount()
    config({ needsGroupBy: true, metric: 'avg_field', groupByFields: [] })
    expect(screen.getByRole('note')).toHaveTextContent('This type has no numeric field: add one in its designer to average or sum it.')
  })
})

describe('WidgetFilterConfig — filter', () => {
  it('offers the filterable fields; the value stays disabled until a field is chosen', async () => {
    const status = field('status', { label: 'Status', fieldType: 'enum', enumValues: ['open', 'closed'] })
    const { user, props } = config({ filterFields: [status], fieldMetaMap: { status } })
    const filter = screen.getByRole('combobox', { name: 'Filter (optional)' })
    expect(options(filter)).toEqual(['No filter', 'Status (enum)'])
    expect(screen.getByRole('textbox', { name: 'Filter value' })).toBeDisabled()
    await user.selectOptions(filter, 'Status (enum)')
    expect(props.onFilterFieldChange).toHaveBeenCalledWith('status')
  })

  it('field metadata without a chosen field still leaves the value disabled', () => {
    config({ filterField: '', selectedFilterMeta: field('status', { fieldType: 'enum', enumValues: ['open'] }) })
    expect(screen.getByRole('textbox', { name: 'Filter value' })).toBeDisabled()
  })

  it('an enum offers its values by their Dictionary label, after "All"', async () => {
    const env = field('environment', { label: 'Environment', fieldType: 'enum', enumValues: ['production', 'lab'], enumTypeName: 'environment' })
    const { user, props } = config({ filterFields: [env], fieldMetaMap: { environment: env }, filterField: 'environment', selectedFilterMeta: env })
    const value = screen.getByRole('combobox', { name: 'Filter value' })
    // "lab" is not in the vocabulary: the true value, shown as it is.
    expect(options(value)).toEqual(['-- All --', 'Production', 'lab'])
    await user.selectOptions(value, 'Production')
    expect(props.onFilterValueChange).toHaveBeenCalledWith('production')
  })

  it('an enum without a vocabulary shows its stored values', () => {
    const tier = field('tier', { fieldType: 'enum', enumValues: ['gold', 'silver'] })
    config({ filterField: 'tier', selectedFilterMeta: tier })
    expect(options(screen.getByRole('combobox', { name: 'Filter value' }))).toEqual(['-- All --', 'gold', 'silver'])
  })

  it('a yes/no field is two buttons; pressing the chosen one again removes the filter', async () => {
    const vip = field('vip', { label: 'VIP', fieldType: 'boolean' })
    const { user, props } = config({ filterField: 'vip', selectedFilterMeta: vip, filterValue: 'true' })
    const group = screen.getByRole('group', { name: 'Filter value' })
    expect(within(group).getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(within(group).getByRole('button', { name: 'Yes' }))
    await user.click(within(group).getByRole('button', { name: 'No' }))
    expect(vi.mocked(props.onFilterValueChange).mock.calls).toEqual([[''], ['false']])
  })

  it('a date field takes a date', () => {
    const opened = field('opened_on', { fieldType: 'date' })
    const { props } = config({ filterField: 'opened_on', selectedFilterMeta: opened, filterValue: '2026-09-01' })
    const date = screen.getByLabelText('Filter value')
    expect(date).toHaveAttribute('type', 'date')
    expect(date).toHaveValue('2026-09-01')
    fireEvent.change(date, { target: { value: '2026-09-02' } })
    expect(props.onFilterValueChange).toHaveBeenCalledWith('2026-09-02')
  })

  it('a number field takes a number', async () => {
    const score = field('score', { fieldType: 'number' })
    const { user, props } = config({ filterField: 'score', selectedFilterMeta: score })
    const value = screen.getByRole('spinbutton', { name: 'Filter value' })
    expect(value).toHaveAttribute('placeholder', 'E.g. 5')
    await user.type(value, '7')
    expect(props.onFilterValueChange).toHaveBeenCalledWith('7')
  })

  it('a text field, or an enum with no values, takes free text', async () => {
    const owner = field('owner')
    const { user, props, unmount } = config({ filterField: 'owner', selectedFilterMeta: owner })
    const value = screen.getByRole('textbox', { name: 'Filter value' })
    expect(value).toBeEnabled()
    expect(value).toHaveAttribute('placeholder', 'E.g. new')
    await user.type(value, 'x')
    expect(props.onFilterValueChange).toHaveBeenCalledWith('x')
    unmount()
    config({ filterField: 'kind', selectedFilterMeta: field('kind', { fieldType: 'enum', enumValues: [] }) })
    expect(screen.getByRole('textbox', { name: 'Filter value' })).toBeEnabled()
  })
})

describe('WidgetFilterConfig — period, size, colour', () => {
  it('the period is six buttons; the chosen one is pressed and a click reports its value', async () => {
    const { user, props } = config({ timeRange: '30d' })
    const period = screen.getByRole('group', { name: 'Period' })
    expect(within(period).getAllByRole('button').map((b) => b.textContent)).toEqual(['24h', '7d', '30d', '90d', '1 year', 'All'])
    expect(within(period).getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(period).getByRole('button', { name: '30d' })).toHaveStyle({ color: '#0284c7' })
    expect(within(period).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(within(period).getByRole('button', { name: '1 year' }))
    expect(props.onTimeRangeChange).toHaveBeenCalledWith('1y')
  })

  it('the size is three buttons, each saying how much width it takes', async () => {
    const { user, props } = config({ size: 'large' })
    const size = screen.getByRole('group', { name: 'Size' })
    expect(within(size).getAllByRole('button').map((b) => b.textContent)).toEqual(['Small1/4 width', 'Medium1/2 width', 'LargeFull width'])
    expect(within(size).getByRole('button', { name: /Large/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(size).getByRole('button', { name: /Medium/ })).toHaveAttribute('aria-pressed', 'false')
    await user.click(within(size).getByRole('button', { name: /Small/ }))
    expect(props.onSizeChange).toHaveBeenCalledWith('small')
  })

  it('six named colours from the theme, plus a custom colour', async () => {
    const { user, props } = config({ color: '#16a34a' })
    const colours = screen.getByRole('group', { name: 'Color' })
    expect(within(colours).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Cyan', 'Green', 'Red', 'Amber', 'Purple', 'Slate'])
    expect(within(colours).getByRole('button', { name: 'Green' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(colours).getByRole('button', { name: 'Cyan' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(within(colours).getByRole('button', { name: 'Red' }))
    expect(props.onColorChange).toHaveBeenCalledWith('#ef4444')
    const custom = screen.getByLabelText('Custom color')
    expect(custom).toHaveValue('#16a34a')
    fireEvent.change(custom, { target: { value: '#123456' } })
    expect(props.onColorChange).toHaveBeenLastCalledWith('#123456')
  })

  it('a widget with a fixed data source configures only its size and colour', () => {
    config({ dataConfigurable: false, needsGroupBy: true })
    expect(screen.queryByRole('combobox', { name: 'Entity' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Metric' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Group by field' })).toBeNull()
    expect(screen.queryByLabelText('Filter value')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Period' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Size' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Color' })).toBeInTheDocument()
  })
})
