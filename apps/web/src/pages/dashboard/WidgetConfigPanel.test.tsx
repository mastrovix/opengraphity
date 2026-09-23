/**
 * THE CUSTOM WIDGET DIALOG of the dashboard: title, type, data options and a
 * live preview, then "Create widget" or "Update widget".
 *
 * What a user loses if it regresses:
 *  - a widget saved without a title, or saved twice by a second click while
 *    the first save is still running;
 *  - a widget that counts something else than what was configured: the save
 *    must carry every option, for the right dashboard (create) or the right
 *    widget (update), and changing the metric or the filter field must not
 *    leave a stale grouping or filter value behind;
 *  - a type with a fixed data source (alarms, services) must say where its
 *    data comes from instead of offering options it ignores;
 *  - a failed save must say so and keep what was typed;
 *  - the dialog closes from its X, Cancel, Escape or a click outside — and a
 *    click INSIDE the panel must not throw the work away; while it is open the
 *    keyboard stays inside it.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { screen, within, waitFor, fireEvent } from '@testing-library/react'
import { renderWithProviders, setCssVars } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { resetCssVarCache } from '@/lib/charts/cssVar'
import { WidgetConfigPanel } from './WidgetConfigPanel'
import type { CustomWidgetData } from './CustomWidgetCard'

/*
 * The fake Apollo of the page tests, with one addition: the server's answer
 * to a mutation can be HELD (`attesa.porta`), to see the dialog while it is
 * saving. Nothing else changes.
 */
const attesa = vi.hoisted(() => ({ porta: null as Promise<void> | null }))
vi.mock('@apollo/client/react', async () => {
  const base = (await import('@/test/apolloFinto')).moduloApollo()
  return {
    ...base,
    useMutation: (...args: Parameters<typeof base.useMutation>) => {
      const [run, state] = base.useMutation(...args) as [(o?: unknown) => Promise<unknown>, unknown]
      const held = async (o?: unknown) => {
        if (attesa.porta) await attesa.porta
        return run(o)
      }
      return [held, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

let clearCssVars: () => void = () => {}
beforeAll(() => {
  resetCssVarCache()
  clearCssVars = setCssVars({
    '--color-brand': '#0284c7', '--color-success': '#16a34a', '--color-danger': '#ef4444',
    '--color-warning': '#eab308', '--color-purple-light': '#8b5cf6', '--color-slate': '#64748b',
  })
})
afterAll(() => { clearCssVars(); resetCssVarCache() })

const campo = (name: string, label: string, over: Record<string, unknown> = {}) => ({
  name, label, fieldType: 'string', enumValues: [], enumTypeName: null, groupable: true, numeric: false, custom: false, ...over,
})

const CATALOG = [
  { entityType: 'incident', label: 'Incident', group: 'itsm', fields: [
    campo('priority', 'Priority', { fieldType: 'enum', enumValues: ['high', 'low'] }),
    campo('status', 'Status', { fieldType: 'enum', enumValues: ['open', 'closed'] }),
  ] },
  { entityType: 'server', label: 'Server', group: 'cmdb', fields: [campo('os', 'Operating system')] },
]

const SAVED: CustomWidgetData = {
  id: 'cw9', title: 'Critical incidents', widgetType: 'chart_bar', entityType: 'incident', metric: 'count_by_field',
  groupByField: 'priority', filterField: 'status', filterValue: 'open', timeRange: '7d', size: 'large',
  color: '#ef4444', position: 3, dashboardId: 'd1',
}

beforeEach(() => {
  apolloFinto.reset()
  attesa.porta = null
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetWidgetCatalog'] = { widgetCatalog: CATALOG }
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Incident', fields: [] }] }
  apolloFinto.esiti['CreateCustomWidget'] = { data: { createCustomWidget: SAVED } }
  apolloFinto.esiti['UpdateCustomWidget'] = { data: { updateCustomWidget: { ...SAVED, id: 'cw1', title: 'Renamed' } } }
})

function panel(widget: CustomWidgetData | null = null) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const r = renderWithProviders(<WidgetConfigPanel dashboardId="d1" widget={widget} onClose={onClose} onSaved={onSaved} />)
  return { ...r, onClose, onSaved }
}

const dialog = () => screen.getByRole('dialog')
const inDialog = () => within(dialog())

describe('WidgetConfigPanel — create', () => {
  it('is titled "New custom widget", and "Create widget" waits for a title that is not just spaces', async () => {
    const { user } = panel()
    expect(screen.getByRole('dialog', { name: 'New custom widget' })).toBeInTheDocument()
    const create = inDialog().getByRole('button', { name: 'Create widget' })
    expect(create).toBeDisabled()
    const title = inDialog().getByRole('textbox', { name: 'Title *' })
    await user.type(title, '   ')
    expect(create).toBeDisabled()
    await user.type(title, 'Open incidents')
    expect(create).toBeEnabled()
  })

  it('sends every option, for this dashboard, then hands back the saved widget', async () => {
    const { user, onSaved } = panel()
    await user.type(inDialog().getByRole('textbox', { name: 'Title *' }), 'Critical incidents')
    await user.click(inDialog().getByRole('button', { name: 'Bar Chart' }))
    await user.selectOptions(inDialog().getByRole('combobox', { name: 'Metric' }), 'Count by field')
    await user.selectOptions(inDialog().getByRole('combobox', { name: 'Group by field' }), 'Priority (enum)')
    await user.selectOptions(inDialog().getByRole('combobox', { name: 'Filter (optional)' }), 'Status (enum)')
    await user.selectOptions(inDialog().getByRole('combobox', { name: 'Filter value' }), 'open')
    await user.click(within(inDialog().getByRole('group', { name: 'Period' })).getByRole('button', { name: '7d' }))
    await user.click(within(inDialog().getByRole('group', { name: 'Size' })).getByRole('button', { name: /Large/ }))
    await user.click(inDialog().getByRole('button', { name: 'Red' }))
    await user.click(inDialog().getByRole('button', { name: 'Create widget' }))

    expect(apolloFinto.chiamata('CreateCustomWidget')).toEqual({ input: {
      title: 'Critical incidents', widgetType: 'chart_bar', entityType: 'incident', metric: 'count_by_field',
      groupByField: 'priority', filterField: 'status', filterValue: 'open', timeRange: '7d', size: 'large',
      color: '#ef4444', dashboardId: 'd1',
    } })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SAVED))
    expect(toast.success).toHaveBeenCalledWith('Widget created')
  })

  it('a plain widget is saved with the theme colour and no grouping, filter or period', async () => {
    const { user, onSaved } = panel()
    await user.type(inDialog().getByRole('textbox', { name: 'Title *' }), '  Open incidents  ')
    await user.click(inDialog().getByRole('button', { name: 'Create widget' }))
    expect(apolloFinto.chiamata('CreateCustomWidget')).toEqual({ input: {
      title: 'Open incidents', widgetType: 'counter', entityType: 'incident', metric: 'count',
      groupByField: null, filterField: null, filterValue: null, timeRange: null, size: 'medium',
      color: '#0284c7', dashboardId: 'd1',
    } })
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it('changing the metric forgets the grouping; changing the filter field forgets the value', async () => {
    const { user } = panel()
    const metric = inDialog().getByRole('combobox', { name: 'Metric' })
    await user.selectOptions(metric, 'Count by field')
    await user.selectOptions(inDialog().getByRole('combobox', { name: 'Group by field' }), 'Priority (enum)')
    await user.selectOptions(metric, 'Field average')
    await user.selectOptions(metric, 'Count by field')
    expect(inDialog().getByRole('combobox', { name: 'Group by field' })).toHaveValue('')

    const filter = inDialog().getByRole('combobox', { name: 'Filter (optional)' })
    await user.selectOptions(filter, 'Status (enum)')
    await user.selectOptions(inDialog().getByRole('combobox', { name: 'Filter value' }), 'open')
    await user.selectOptions(filter, 'Priority (enum)')
    expect(inDialog().getByRole('combobox', { name: 'Filter value' })).toHaveValue('')
  })

  it('while the save runs the button says "Saving…" and cannot be pressed again', async () => {
    let rispondi!: () => void
    attesa.porta = new Promise((r) => { rispondi = r })
    const { user, onSaved } = panel()
    await user.type(inDialog().getByRole('textbox', { name: 'Title *' }), 'Open incidents')
    await user.click(inDialog().getByRole('button', { name: 'Create widget' }))
    const saving = await inDialog().findByRole('button', { name: 'Saving…' })
    expect(saving).toBeDisabled()
    rispondi()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(apolloFinto.chiamate['CreateCustomWidget']).toHaveLength(1)
  })

  it('a failed save says why and keeps the dialog, with what was typed, ready to retry', async () => {
    apolloFinto.esiti['CreateCustomWidget'] = { error: new Error('widget store unavailable') }
    const { user, onSaved, onClose } = panel()
    await user.type(inDialog().getByRole('textbox', { name: 'Title *' }), 'Open incidents')
    await user.click(inDialog().getByRole('button', { name: 'Create widget' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Widget save failed: widget store unavailable'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(inDialog().getByRole('textbox', { name: 'Title *' })).toHaveValue('Open incidents')
    expect(inDialog().getByRole('button', { name: 'Create widget' })).toBeEnabled()
  })
})

describe('WidgetConfigPanel — edit', () => {
  const EXISTING: CustomWidgetData = {
    id: 'cw1', title: 'Servers by OS', widgetType: 'table', entityType: 'server', metric: 'count_by_field',
    groupByField: 'os', filterField: null, filterValue: null, timeRange: '30d', size: 'small', color: '#16a34a',
    position: 0, dashboardId: 'd1',
  }

  it('opens as "Edit widget" with the saved options, and "Update widget" saves that widget', async () => {
    const { user, onSaved } = panel(EXISTING)
    expect(screen.getByRole('dialog', { name: 'Edit widget' })).toBeInTheDocument()
    const title = inDialog().getByRole('textbox', { name: 'Title *' })
    expect(title).toHaveValue('Servers by OS')
    expect(inDialog().getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true')
    expect(inDialog().getByRole('combobox', { name: 'Entity' })).toHaveValue('server')
    expect(inDialog().getByRole('combobox', { name: 'Group by field' })).toHaveValue('os')
    expect(within(inDialog().getByRole('group', { name: 'Period' })).getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true')

    await user.clear(title)
    await user.type(title, 'Renamed')
    await user.click(inDialog().getByRole('button', { name: 'Update widget' }))
    expect(apolloFinto.chiamata('UpdateCustomWidget')).toEqual({ id: 'cw1', input: {
      title: 'Renamed', widgetType: 'table', entityType: 'server', metric: 'count_by_field', groupByField: 'os',
      filterField: null, filterValue: null, timeRange: '30d', size: 'small', color: '#16a34a',
    } })
    expect(apolloFinto.chiamate['CreateCustomWidget']).toBeUndefined()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'cw1', title: 'Renamed' })))
    expect(toast.success).toHaveBeenCalledWith('Widget updated')
  })
})

describe('WidgetConfigPanel — types with a fixed data source', () => {
  it('says where the data comes from and hides the data options; a data type brings them back', async () => {
    const { user } = panel()
    await user.click(inDialog().getByRole('button', { name: 'Active alarms' }))
    expect(inDialog().getByText(/live counters of the alarm console/)).toBeInTheDocument()
    expect(inDialog().queryByRole('combobox', { name: 'Entity' })).toBeNull()
    expect(inDialog().getByRole('group', { name: 'Size' })).toBeInTheDocument()

    await user.click(inDialog().getByRole('button', { name: 'Service health' }))
    expect(inDialog().getByText(/monitored-service counters/)).toBeInTheDocument()
    expect(inDialog().queryByText(/alarm console/)).toBeNull()

    await user.click(inDialog().getByRole('button', { name: 'Counter' }))
    expect(inDialog().queryByText(/monitored-service counters/)).toBeNull()
    expect(inDialog().getByRole('combobox', { name: 'Entity' })).toBeInTheDocument()
  })
})

describe('WidgetConfigPanel — closing', () => {
  it('closes from the X, from Cancel and from Escape', async () => {
    const { user, onClose } = panel()
    await user.click(inDialog().getByRole('button', { name: 'Close' }))
    await user.click(inDialog().getByRole('button', { name: 'Cancel' }))
    // Once per press: Escape belongs to the dialog, not also to the form's hook.
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('a click outside the panel closes it; a click inside the panel does not', () => {
    const { onClose } = panel()
    fireEvent.click(dialog())
    fireEvent.click(inDialog().getByRole('heading', { name: 'New custom widget' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(dialog().parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('WidgetConfigPanel — defects found while writing these tests', () => {
  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the dialog declared itself
   * modal (`aria-modal="true"`) but did not keep the keyboard inside, as the
   * product's own `Modal` does; only Escape was handled, by the form's hook.
   * Tab from its last button left for the page behind the overlay — on the
   * dashboard, the header's "Save" of the layout, which then saved under the
   * open dialog. The dialog now uses the shared `useDialogFocus`.
   */
  it('Tab from the last button of the dialog stays inside it', async () => {
    const { user } = renderWithProviders(
      <>
        <button type="button">Behind the dialog</button>
        <WidgetConfigPanel dashboardId="d1" widget={null} onClose={vi.fn()} onSaved={vi.fn()} />
      </>,
    )
    await user.type(inDialog().getByRole('textbox', { name: 'Title *' }), 'Open incidents')
    inDialog().getByRole('button', { name: 'Create widget' }).focus()
    await user.tab()
    expect(dialog()).toContainElement(document.activeElement as HTMLElement)
  })
})
