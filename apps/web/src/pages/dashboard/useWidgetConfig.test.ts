/**
 * THE WIDGET CONFIGURATION PANEL'S STATE.
 *
 * The preview is the part with rules. It waits 600 ms after the last change
 * (one query per keystroke otherwise), and it waits for a COMPLETE
 * configuration: choosing "Count by field" used to fire a preview with no
 * field at once, and the server answered with an error toast before the
 * field could be picked (browser run, 14 Sep 2026). A widget type that reads
 * a fixed source (active alarms, service health) has no preview at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

type Doc = { definitions: Array<{ kind: string; name?: { value: string } }> }
const opName = (doc: Doc) => doc.definitions.find((d) => d.kind === 'OperationDefinition')?.name?.value ?? ''

const m = vi.hoisted(() => ({
  catalog: [] as unknown[],
  preview: null as unknown,
  previewCalls: [] as Array<{ variables: unknown; skip: boolean }>,
  create: vi.fn(), update: vi.fn(),
  toastError: vi.fn(), toastSuccess: vi.fn(), showError: vi.fn(),
}))

vi.mock('@apollo/client/react', () => ({
  useQuery: (doc: Doc, opts: { variables?: unknown; skip?: boolean }) => {
    const name = opName(doc)
    if (/Catalog/i.test(name)) return { data: { widgetCatalog: m.catalog } }
    m.previewCalls.push({ variables: opts.variables, skip: !!opts.skip })
    return { data: opts.skip ? undefined : m.preview, loading: false }
  },
  useMutation: (doc: Doc) => [/Create/i.test(opName(doc)) ? m.create : m.update],
}))
vi.mock('sonner', () => ({ toast: { error: m.toastError, success: m.toastSuccess } }))
vi.mock('@/lib/showError', () => ({ showError: m.showError, errorMessage: (e: unknown) => String(e) }))
vi.mock('@/lib/charts/cssVar', () => ({ cssVar: (name: string) => `#${name.length.toString(16).padStart(6, '0')}` }))

const mod = await import('./useWidgetConfig')
const { useWidgetConfig, widgetTint, presetColors, groupByFieldsFor, metricNeedsGroupBy } = mod

const campo = (name: string, over: Record<string, unknown> = {}) => ({
  name, label: name, fieldType: 'string', enumValues: [], enumTypeName: null, groupable: true, numeric: false, custom: false, ...over,
})
const CATALOG = [
  { entityType: 'incident', label: 'Incident', group: 'itsm', fields: [campo('severity'), campo('cost', { numeric: true, groupable: false })] },
  { entityType: 'server', label: 'Server', group: 'cmdb', fields: [campo('os')] },
]

beforeEach(() => {
  vi.useFakeTimers()
  m.catalog = CATALOG; m.preview = null; m.previewCalls = []
  for (const f of [m.create, m.update, m.toastError, m.toastSuccess, m.showError]) f.mockReset()
})
afterEach(() => { vi.useRealTimers() })

const monta = (widget: unknown = null) => {
  const onClose = vi.fn(); const onSaved = vi.fn()
  const h = renderHook(() => useWidgetConfig({ dashboardId: 'd1', widget: widget as never, onClose, onSaved }))
  return { ...h, onClose, onSaved }
}

describe('the pure helpers', () => {
  it('widgetTint adds an alpha suffix to a hex, and uses color-mix for anything else', () => {
    expect(widgetTint('#112233')).toBe('#11223314')
    expect(widgetTint('#112233', '33')).toBe('#11223333')
    expect(widgetTint('var(--color-brand)')).toBe('color-mix(in srgb, var(--color-brand) 8%, transparent)')
    expect(widgetTint('rgb(1,2,3)', '33')).toBe('color-mix(in srgb, rgb(1,2,3) 20%, transparent)')
  })

  it('the preset colours come from the tokens, resolved to concrete values', () => {
    // The colour is DATA saved on the widget and shown in <input type=color>:
    // it has to be a concrete hex, never `var(--…)`.
    for (const c of presetColors()) expect(c.value).toMatch(/^#/)
  })

  it('averages and sums group by numeric fields, counts by groupable ones', () => {
    const e = CATALOG[0] as never
    expect(groupByFieldsFor(e, 'avg_field').map((f) => f.name)).toEqual(['cost'])
    expect(groupByFieldsFor(e, 'count_by_field').map((f) => f.name)).toEqual(['severity'])
    expect(groupByFieldsFor(undefined, 'count')).toEqual([])
    expect(['count_by_field', 'avg_field', 'sum_field'].every(metricNeedsGroupBy)).toBe(true)
    expect(metricNeedsGroupBy('count')).toBe(false)
  })
})

describe('useWidgetConfig', () => {
  it('a new widget starts as an incident counter over all time', () => {
    const { result } = monta()
    expect(result.current).toMatchObject({ isEdit: false, widgetType: 'counter', entityType: 'incident', metric: 'count', timeRange: 'all', size: 'medium' })
    expect(result.current.entities).toHaveLength(2)
  })

  it('an existing widget starts from its own values', () => {
    const { result } = monta({ id: 'w1', title: 'Open', widgetType: 'table', entityType: 'server', metric: 'count_by_field',
      groupByField: 'os', filterField: null, filterValue: null, timeRange: '7d', size: 'large', color: '#abcdef', position: 0, dashboardId: 'd1' })
    expect(result.current).toMatchObject({ isEdit: true, entityType: 'server', groupByField: 'os', needsGroupBy: true, color: '#abcdef' })
    expect(result.current.groupByFields.map((f) => f.name)).toEqual(['os'])
    expect(Object.keys(result.current.fieldMetaMap)).toEqual(['os'])
  })

  it('the preview waits 600 ms of quiet', () => {
    const { result } = monta()
    expect(m.previewCalls.every((c) => c.skip)).toBe(true)
    act(() => { vi.advanceTimersByTime(600) })
    expect(m.previewCalls.at(-1)).toMatchObject({ skip: false, variables: { entityType: 'incident', metric: 'count' } })
    void result
  })

  it('the preview does NOT fire for a per-field metric until the field is chosen', () => {
    const { result } = monta()
    act(() => { result.current.setMetric('count_by_field') })
    act(() => { vi.advanceTimersByTime(600) })
    expect(m.previewCalls.at(-1)!.skip).toBe(true)
    act(() => { result.current.setGroupByField('severity') })
    act(() => { vi.advanceTimersByTime(600) })
    expect(m.previewCalls.at(-1)).toMatchObject({ skip: false, variables: { groupByField: 'severity' } })
  })

  it('filter and time range reach the preview only when set', () => {
    const { result } = monta()
    act(() => { result.current.setFilterField('severity'); result.current.setFilterValue('high'); result.current.setTimeRange('7d') })
    act(() => { vi.advanceTimersByTime(600) })
    expect(m.previewCalls.at(-1)!.variables).toMatchObject({ filterField: 'severity', filterValue: 'high', timeRange: '7d' })
    expect(result.current.selectedFilterMeta?.name).toBe('severity')
  })

  it('a widget with a fixed source has no preview at all', () => {
    const { result } = monta()
    act(() => { result.current.setWidgetType('active_alarms') })
    act(() => { vi.advanceTimersByTime(600) })
    expect(m.previewCalls.at(-1)!.skip).toBe(true)
  })

  it('the preview data comes back to the panel', () => {
    m.preview = { widgetDataPreview: { value: 7, label: null, series: [] } }
    const { result } = monta()
    act(() => { vi.advanceTimersByTime(600) })
    expect(result.current.previewData).toEqual({ value: 7, label: null, series: [] })
  })

  it('changing entity clears grouping and filter: they named fields of the other entity', () => {
    const { result } = monta()
    act(() => { result.current.setGroupByField('severity'); result.current.setFilterField('severity'); result.current.setFilterValue('high') })
    act(() => { result.current.handleEntityChange('server') })
    expect(result.current).toMatchObject({ entityType: 'server', groupByField: '', filterField: '', filterValue: '' })
  })

  it('no title, no save', async () => {
    const { result } = monta()
    await act(async () => { await result.current.handleSave() })
    expect(m.toastError).toHaveBeenCalled()
    expect(m.create).not.toHaveBeenCalled()
  })

  it('a new widget is created in its dashboard, with blanks sent as null', async () => {
    m.create.mockResolvedValue({ data: { createCustomWidget: { id: 'w9' } } })
    const { result, onSaved } = monta()
    act(() => { result.current.setTitle('  Open incidents  '); result.current.setGroupByField('severity') })
    await act(async () => { await result.current.handleSave() })
    expect(m.create).toHaveBeenCalledWith({ variables: { input: expect.objectContaining({
      dashboardId: 'd1', title: 'Open incidents', groupByField: null, filterField: null, timeRange: null,
    }) } })
    expect(onSaved).toHaveBeenCalledWith({ id: 'w9' })
    expect(result.current.saving).toBe(false)
  })

  it('an existing widget is updated by id', async () => {
    m.update.mockResolvedValue({ data: { updateCustomWidget: { id: 'w1' } } })
    const { result, onSaved } = monta({ id: 'w1', title: 'Open', widgetType: 'counter', entityType: 'incident', metric: 'count',
      groupByField: null, filterField: null, filterValue: null, timeRange: '30d', size: 'small', color: '#000000', position: 0, dashboardId: 'd1' })
    await act(async () => { await result.current.handleSave() })
    expect(m.update).toHaveBeenCalledWith({ variables: { id: 'w1', input: expect.objectContaining({ timeRange: '30d' }) } })
    expect(onSaved).toHaveBeenCalledWith({ id: 'w1' })
  })

  it('a failed save is shown and the panel stays usable', async () => {
    m.create.mockRejectedValue(new Error('nope'))
    const { result, onSaved } = monta()
    act(() => { result.current.setTitle('x') })
    await act(async () => { await result.current.handleSave() })
    expect(m.showError).toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(result.current.saving).toBe(false)
  })

  it('Escape closes the panel, and the listener goes away with it', () => {
    const { onClose, unmount } = monta()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onClose).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('the small setters all work', () => {
    const { result } = monta()
    act(() => { result.current.setSize('large'); result.current.setColor('#123456') })
    expect(result.current).toMatchObject({ size: 'large', color: '#123456' })
  })
})
