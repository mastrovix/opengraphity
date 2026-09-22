/**
 * The report list and the report detail both draw a report's icon from its
 * FIRST section's chart type. If `getReportIcon` regresses, a pie report shows
 * a bar chart in the list (the user reads the wrong kind of report before
 * opening it), and a report without sections — a freshly created one — must
 * still render an icon instead of crashing the whole list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { BarChart2 } from 'lucide-react'
import { CHART_ICON_MAP, getReportIcon } from './reportIcons'
import type { ReportTemplate } from './useCustomReports'

const template = (sections: Array<{ chartType: string }> | undefined): ReportTemplate =>
  ({ id: 'r1', name: 'R', sections } as unknown as ReportTemplate)

/** The markup a given icon component draws, to compare icons by what the user sees. */
const markupOf = (el: React.ReactElement) => render(el).container.innerHTML

afterEach(() => { vi.restoreAllMocks() })

describe('getReportIcon', () => {
  it('draws the icon of the first section chart type, in the brand colour and requested size', () => {
    const Pie = CHART_ICON_MAP['pie']!
    const html = markupOf(getReportIcon(template([{ chartType: 'pie' }, { chartType: 'table' }]), 32))
    expect(html).toBe(markupOf(<Pie size={32} color="var(--color-brand)" />))
    // The second section must not win: the icon describes the report's lead chart.
    const Table = CHART_ICON_MAP['table']!
    expect(html).not.toBe(markupOf(<Table size={32} color="var(--color-brand)" />))
  })

  it('a report with no sections yet gets the bar icon at the default size, silently', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(markupOf(getReportIcon(template([])))).toBe(markupOf(<BarChart2 size={20} color="var(--color-brand)" />))
    expect(markupOf(getReportIcon(template(undefined))))
      .toBe(markupOf(<BarChart2 size={20} color="var(--color-brand)" />))
    // "No sections" is a normal state, not a broken contract: nothing in the console.
    expect(spy).not.toHaveBeenCalled()
  })

  it('an unknown chart type still renders (bar fallback) but is reported in the console', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(markupOf(getReportIcon(template([{ chartType: 'sankey' }]))))
      .toBe(markupOf(<BarChart2 size={20} color="var(--color-brand)" />))
    // No silent fallback: a chart type the web does not know must be visible to a developer.
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"sankey"'))
  })
})
