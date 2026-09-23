/**
 * A REPORT WIDGET on a dashboard in view mode: the title of the report
 * section, the report it comes from, and the section as the report renderer
 * draws it.
 *
 * What a user loses if this regresses: a widget whose section was deleted in
 * the report must still be a card ("Widget"), not a hole in the grid; an error
 * computed by the server must read as an error, not as an empty chart that
 * looks like "nothing to report"; and the card must take the width the user
 * gave it in edit mode.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DashboardWidget, type DashboardWidgetData } from './DashboardWidget'

const widget = (over: Partial<DashboardWidgetData> = {}): DashboardWidgetData => ({
  id: 'w1', order: 0, colSpan: 6, reportTemplateId: 'rt1', reportSectionId: 's1',
  data: JSON.stringify({ value: 42, label: 'open now' }), error: null,
  reportSection: { id: 's1', title: 'Open incidents', chartType: 'kpi' },
  reportTemplate: { id: 'rt1', name: 'Weekly report' },
  ...over,
})

describe('DashboardWidget', () => {
  it('shows the section title, the report it belongs to, and the section data', () => {
    render(<DashboardWidget widget={widget()} />)
    expect(screen.getByText('Open incidents')).toBeInTheDocument()
    expect(screen.getByText('Weekly report')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('open now')).toBeInTheDocument()
  })

  it('a widget whose section and report are gone is still a card, named "Widget", without a report line', () => {
    render(<DashboardWidget widget={widget({ reportSection: null, reportTemplate: null, data: null })} />)
    expect(screen.getByText('Widget')).toBeInTheDocument()
    expect(screen.queryByText('Weekly report')).toBeNull()
    expect(screen.getByText('Chart not available with the selected parameters')).toBeInTheDocument()
  })

  it('an error computed by the server is shown as a computation error with its message', () => {
    render(<DashboardWidget widget={widget({ error: 'the report query timed out', data: null })} />)
    expect(screen.getByText('Error computing the section')).toBeInTheDocument()
    expect(screen.getByText('the report query timed out')).toBeInTheDocument()
    expect(screen.queryByText('42')).toBeNull()
  })

  it('the card spans the number of grid columns the user chose', () => {
    const { container } = render(<DashboardWidget widget={widget({ colSpan: 12 })} />)
    expect(container.firstElementChild).toHaveStyle({ gridColumn: 'span 12' })
  })
})
