/**
 * THE DASHBOARD IN EDIT MODE: the widgets being arranged on the left, and the
 * two ways of adding more on the right — custom widgets, and the sections of
 * the saved reports.
 *
 * What the user relies on:
 *  - every report widget being arranged shows its section, its report, and a
 *    "new" badge until the layout is saved; its width selector and its remove
 *    button act on THAT widget (acting on a neighbour is a silent layout bug);
 *  - a widget removed in this session leaves the grid at once;
 *  - an empty layout says how to fill it, rather than showing a blank area;
 *  - the custom widgets are listed with a count, each with its own edit and
 *    delete, both in the side list and on the card itself;
 *  - each report opens to its sections, and "Add" adds THAT section of THAT
 *    report; a report without sections, and no reports at all, are said.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { DashboardEditMode, type PendingWidget } from './DashboardEditMode'
import type { CustomWidgetData } from './CustomWidgetCard'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const pending = (tempId: string, over: Partial<PendingWidget> = {}): PendingWidget => ({
  tempId, serverId: tempId, reportTemplateId: 'rt1', reportSectionId: `s-${tempId}`, colSpan: 6, order: 0,
  reportSection: { id: `s-${tempId}`, title: `Section ${tempId}`, chartType: 'kpi' },
  reportTemplate: { id: 'rt1', name: 'Weekly report' },
  data: JSON.stringify({ value: 42, label: 'open' }), isNew: false, isDeleted: false,
  ...over,
})

const custom = (id: string, title: string, over: Partial<CustomWidgetData> = {}): CustomWidgetData => ({
  id, title, widgetType: 'counter', entityType: 'incident', metric: 'count', groupByField: null, filterField: null,
  filterValue: null, timeRange: null, size: 'small', color: '#0ea5e9', position: 0, dashboardId: 'd1', ...over,
})

const WEEKLY = { id: 'rt1', name: 'Weekly report', sections: [
  { id: 's1', title: 'Open incidents', chartType: 'kpi', order: 0 },
  { id: 's2', title: 'Backlog', chartType: 'bar', order: 1 },
] }
const SLA = { id: 'rt2', name: 'SLA report', sections: [] }

type Props = ComponentProps<typeof DashboardEditMode>

function editMode(over: Partial<Props> = {}) {
  const props: Props = {
    pendingWidgets: [], templates: [], expandedTemplates: new Set(), customWidgets: [],
    onDragEnd: vi.fn(), onRemoveWidget: vi.fn(), onUpdateColSpan: vi.fn(), onAddWidget: vi.fn(),
    onToggleTemplate: vi.fn(), onAddCustomWidget: vi.fn(), onEditCustomWidget: vi.fn(), onDeleteCustomWidget: vi.fn(),
    ...over,
  }
  const r = renderWithProviders(<DashboardEditMode {...props} />)
  return { ...r, props }
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetWidgetData'] = { widgetData: { value: 7, label: null, series: [] } }
})

/**
 * jsdom has no layout: every element measures 0×0 at the origin, so a drag
 * could never land anywhere. Here each sortable widget gets a box in a row,
 * 400 px apart (widget n spans x = 400n … 400n + 300), which is all the drag
 * and drop library needs to find the widget under the pointer.
 */
function placeWidgetsInARow() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const sortable = this.getAttribute('aria-roledescription') === 'sortable'
    const x = sortable ? Array.from(this.parentElement!.children).indexOf(this) * 400 : 0
    const [width, height] = sortable ? [300, 200] : [0, 0]
    return { x, y: 0, left: x, top: 0, right: x + width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect
  })
}

/**
 * After a drop the drag and drop library swallows clicks on the document for
 * a moment (so the release of the mouse is not also a click). Wait until a
 * click reaches its target again, or the next test's first click is lost.
 */
async function clicksGetThroughAgain() {
  // The probe is added once: changing the DOM inside `waitFor` would re-run it without end.
  const probe = vi.fn()
  const button = document.createElement('button')
  button.addEventListener('click', probe)
  document.body.append(button)
  await waitFor(() => {
    button.click()
    expect(probe).toHaveBeenCalled()
  })
  button.remove()
}

describe('DashboardEditMode — the layout being arranged', () => {
  it('an empty layout explains how to fill it — also when every widget was removed in this session', () => {
    editMode({ pendingWidgets: [pending('w1', { isDeleted: true })] })
    expect(screen.getByText('Empty dashboard')).toBeInTheDocument()
    expect(screen.getByText('Use the panel on the right to add custom widgets or reports.')).toBeInTheDocument()
    expect(screen.queryByText('Section w1')).toBeNull()
  })

  it('each report widget shows its section and report, a "new" badge until saved, and leaves the grid once removed', () => {
    editMode({ pendingWidgets: [
      pending('w1'),
      pending('w2', { isNew: true, serverId: undefined }),
      pending('w3', { isDeleted: true }),
    ] })
    const first = screen.getByText('Section w1').closest('[aria-roledescription="sortable"]') as HTMLElement
    expect(within(first).getByText('Weekly report')).toBeInTheDocument()
    expect(within(first).queryByText('new')).toBeNull()
    expect(within(first).getByText('42')).toBeInTheDocument()
    const second = screen.getByText('Section w2').closest('[aria-roledescription="sortable"]') as HTMLElement
    expect(within(second).getByText('new')).toBeInTheDocument()
    expect(screen.queryByText('Section w3')).toBeNull()
    expect(screen.queryByText('Empty dashboard')).toBeNull()
  })

  it('a widget whose section and report are gone is still a card named "Widget", without a report line', () => {
    editMode({ pendingWidgets: [pending('w1', { reportSection: null, reportTemplate: null, data: null })] })
    const card = screen.getByText('Widget').closest('[aria-roledescription="sortable"]') as HTMLElement
    expect(within(card).queryByText('Weekly report')).toBeNull()
    expect(within(card).getByText('Chart not available with the selected parameters')).toBeInTheDocument()
  })

  it('the width selector and the remove button act on their own widget', async () => {
    const { user, props } = editMode({ pendingWidgets: [pending('w1', { colSpan: 6 }), pending('w2', { colSpan: 4 })] })
    const widths = screen.getAllByRole('combobox', { name: 'Width (columns)' })
    expect(widths.map((w) => (w as HTMLSelectElement).value)).toEqual(['6', '4'])
    expect(within(widths[0]!).getAllByRole('option').map((o) => o.textContent)).toEqual(['2 cols', '3 cols', '4 cols', '6 cols', '12 cols'])
    await user.selectOptions(widths[1]!, '12 cols')
    expect(props.onUpdateColSpan).toHaveBeenCalledWith('w2', 12)
    await user.click(screen.getAllByRole('button', { name: 'Remove widget' })[0]!)
    expect(props.onRemoveWidget).toHaveBeenCalledWith('w1')
    expect(props.onUpdateColSpan).toHaveBeenCalledTimes(1)
  })

  it('each widget takes the width it was given', () => {
    editMode({ pendingWidgets: [pending('w1', { colSpan: 12 })] })
    const card = screen.getByText('Section w1').closest('[aria-roledescription="sortable"]') as HTMLElement
    expect(card).toHaveStyle({ gridColumn: 'span 12' })
  })

  it('a widget dragged by its handle onto another one is reported with the one it was dropped on', async () => {
    placeWidgetsInARow()
    const { props } = editMode({ pendingWidgets: [pending('w1'), pending('w2'), pending('w3')] })
    const card = (id: string) => screen.getByText(`Section ${id}`).closest('[aria-roledescription="sortable"]') as HTMLElement
    const handle = within(card('w1')).getByTitle('Drag')

    fireEvent.pointerDown(handle, { isPrimary: true, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(document, { clientX: 30, clientY: 10 })
    // While it is carried, the widget is dimmed.
    await waitFor(() => expect(card('w1')).toHaveStyle({ opacity: '0.5' }))
    expect(card('w2')).toHaveStyle({ opacity: '1' })
    fireEvent.pointerMove(document, { clientX: 810, clientY: 10 })
    fireEvent.pointerUp(document, { clientX: 810, clientY: 10 })
    await clicksGetThroughAgain()

    expect(props.onDragEnd).toHaveBeenCalledTimes(1)
    const [event] = vi.mocked(props.onDragEnd).mock.calls[0]!
    expect(event.active.id).toBe('w1')
    expect(event.over?.id).toBe('w3')
  })
})

describe('DashboardEditMode — custom widgets', () => {
  it('"Create widget" opens the custom widget dialog', async () => {
    const { user, props } = editMode()
    await user.click(screen.getByRole('button', { name: 'Create widget' }))
    expect(props.onAddCustomWidget).toHaveBeenCalledTimes(1)
    // Nothing created yet: no list.
    expect(screen.queryByText(/Created \(/)).toBeNull()
  })

  it('lists the custom widgets with their count; edit and delete act on their own widget', async () => {
    const tickets = custom('cw1', 'Critical tickets')
    const table = custom('cw2', 'By priority', { widgetType: 'table' })
    const { user, props } = editMode({ customWidgets: [tickets, table] })
    const list = screen.getByText('Created (2)').parentElement as HTMLElement
    const row = (title: string) => within(list).getByText(title).parentElement as HTMLElement
    await user.click(within(row('By priority')).getByRole('button', { name: 'Edit' }))
    expect(props.onEditCustomWidget).toHaveBeenCalledWith(table)
    await user.click(within(row('Critical tickets')).getByRole('button', { name: 'Delete' }))
    expect(props.onDeleteCustomWidget).toHaveBeenCalledWith('cw1')
  })

  it('the custom widget cards in the grid carry their own edit and remove', async () => {
    const tickets = custom('cw1', 'Critical tickets')
    const { user, props } = editMode({ customWidgets: [tickets] })
    const card = (await screen.findByText('7')).closest('div[style*="span"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Edit widget' }))
    expect(props.onEditCustomWidget).toHaveBeenCalledWith(tickets)
    await user.click(within(card).getByRole('button', { name: 'Remove widget' }))
    expect(props.onDeleteCustomWidget).toHaveBeenCalledWith('cw1')
    expect(screen.queryByText('Empty dashboard')).toBeNull()
  })
})

describe('DashboardEditMode — add from report', () => {
  it('with no report it says so', () => {
    editMode({ templates: [] })
    expect(screen.getByText('No reports available.')).toBeInTheDocument()
  })

  it('a closed report shows no sections; clicking it asks to open it', async () => {
    const { user, props } = editMode({ templates: [WEEKLY] })
    const report = screen.getByRole('button', { name: /Weekly report/ })
    expect(report).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Add Backlog' })).toBeNull()
    await user.click(report)
    expect(props.onToggleTemplate).toHaveBeenCalledWith('rt1')
  })

  it('an open report lists its sections, and "Add" adds that section of that report', async () => {
    const { user, props } = editMode({ templates: [WEEKLY, SLA], expandedTemplates: new Set(['rt1', 'rt2']) })
    expect(screen.getByRole('button', { name: /Weekly report/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Open incidents')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add Backlog' }))
    expect(props.onAddWidget).toHaveBeenCalledWith(WEEKLY, WEEKLY.sections[1])
    // The SLA report has no section to add.
    expect(screen.getByText('No sections')).toBeInTheDocument()
  })

  it('a report that came without a list of sections reads as a report without sections', () => {
    const broken = { id: 'rt3', name: 'Legacy report', sections: null as unknown as typeof WEEKLY.sections }
    editMode({ templates: [broken], expandedTemplates: new Set(['rt3']) })
    expect(screen.getByText('No sections')).toBeInTheDocument()
  })
})
