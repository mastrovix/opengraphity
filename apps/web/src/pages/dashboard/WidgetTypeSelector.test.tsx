/**
 * THE WIDGET TYPE PICKER of the widget configuration panel.
 *
 * It is the first choice a user makes when building a widget, and it decides
 * what the widget draws and whether it reads configurable data at all (active
 * alarms and service health do not). The behaviours pinned here:
 *  - every type the product offers is a button, named in the viewer's
 *    language, with its description as tooltip;
 *  - the chosen type is announced as pressed — the only way a keyboard or
 *    screen-reader user knows which one is selected;
 *  - a click reports the type's VALUE (what is saved), never its label;
 *  - a type added to the list without an icon is still offered by name,
 *    instead of crashing the whole configuration panel.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WidgetTypeSelector } from './WidgetTypeSelector'

// One extra type, as a developer would add it to WIDGET_TYPES, with an icon
// the picker has no component for.
vi.mock('./useWidgetConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useWidgetConfig')>()
  return {
    ...actual,
    WIDGET_TYPES: [
      ...actual.WIDGET_TYPES,
      { value: 'heatmap', labelKey: 'Heatmap', icon: 'Flame', descKey: 'Density by hour' },
    ],
  }
})

describe('WidgetTypeSelector', () => {
  it('offers every widget type as a button of the "Widget type" group, with its description as tooltip', () => {
    render(<WidgetTypeSelector widgetType="counter" color="#0ea5e9" onSelect={vi.fn()} />)
    const group = screen.getByRole('group', { name: 'Widget type' })
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Counter', 'Bar Chart', 'Line', 'Pie Chart', 'Donut', 'Table', 'Gauge', 'Active alarms', 'Service health', 'Heatmap',
    ])
    expect(within(group).getByRole('button', { name: 'Gauge' })).toHaveAttribute('title', '% of 100')
    expect(within(group).getByRole('button', { name: 'Active alarms' }))
      .toHaveAttribute('title', 'Firing, critical, warning and no-CI alarms from the monitoring')
  })

  it('announces only the chosen type as pressed, and draws it in the widget colour', () => {
    render(<WidgetTypeSelector widgetType="chart_pie" color="#112233" onSelect={vi.fn()} />)
    const chosen = screen.getByRole('button', { name: 'Pie Chart' })
    expect(chosen).toHaveAttribute('aria-pressed', 'true')
    expect(chosen).toHaveStyle({ color: '#112233' })
    expect(screen.getAllByRole('button', { pressed: true })).toEqual([chosen])
    expect(screen.getByRole('button', { name: 'Counter' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports the value of the clicked type, not its translated label', async () => {
    const onSelect = vi.fn()
    render(<WidgetTypeSelector widgetType="counter" color="#0ea5e9" onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Active alarms' }))
    await userEvent.click(screen.getByRole('button', { name: 'Bar Chart' }))
    expect(onSelect.mock.calls).toEqual([['active_alarms'], ['chart_bar']])
  })

  it('a type without a known icon is still offered by its name, and is selectable', async () => {
    const onSelect = vi.fn()
    render(<WidgetTypeSelector widgetType="counter" color="#0ea5e9" onSelect={onSelect} />)
    const heatmap = screen.getByRole('button', { name: 'Heatmap' })
    // The shipped types draw an icon, this one only its name.
    expect(heatmap.querySelector('svg')).toBeNull()
    expect(screen.getByRole('button', { name: 'Counter' }).querySelector('svg')).not.toBeNull()
    await userEvent.click(heatmap)
    expect(onSelect).toHaveBeenCalledWith('heatmap')
  })
})
