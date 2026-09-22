/**
 * The shared pieces of the objective reports (SLA Report, OLA / UC Report).
 *
 * Why these matter: a compliance percentage coloured against a fixed 95/80
 * threshold instead of ITS OWN objective turns a failing 99.5% contract green;
 * a percentage with no finished objective shown as "0%" reads as a total
 * failure; and a report header that hides the "manage" link from admins (or
 * shows it to people who cannot open the page) breaks the road from "this
 * number is wrong" to "change what it measures".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { palette } from '@/lib/tokens'
import { renderWithProviders } from '@/test/utils'
import i18n from '@/i18n/i18n'
import { compliance, pctColor, PctCell, ReportHeader, ReportSubheading, WindowSelector, REPORT_WINDOWS } from './reportWindow'

const perms = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('@/hooks/useMe', () => ({ useMe: () => ({ can: (...p: string[]) => p.some((x) => perms.list.includes(x)) }) }))

const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

beforeEach(() => { perms.list = [] })

describe('pctColor', () => {
  const objective = { target: 99.5, warning: 98 }

  it('colours against the objective of the contract, not a fixed threshold', () => {
    // 96% would be green under the old fixed 95; against a 99.5 target it is red.
    expect(pctColor(96, objective)).toBe(palette.danger.text)
    expect(pctColor(98.5, objective)).toBe(palette.warning.text)
    expect(pctColor(99.5, objective)).toBe(palette.success.text)
  })

  it('stays neutral without a percentage or without a complete objective', () => {
    expect(pctColor(null, objective)).toBe('var(--color-slate)')
    expect(pctColor(50)).toBe('var(--color-slate)')
    expect(pctColor(50, { target: 90, warning: null })).toBe('var(--color-slate)')
    expect(pctColor(50, { target: null, warning: 80 })).toBe('var(--color-slate)')
  })
})

describe('compliance', () => {
  it('counts only the concluded objectives', () => {
    expect(compliance(3, 1)).toBe(75)
    expect(compliance(0, 2)).toBe(0)
  })

  it('is null when nothing has concluded, so the page does not claim 0%', () => {
    expect(compliance(0, 0)).toBeNull()
  })
})

describe('PctCell', () => {
  it('shows a dash with the "no objective" hint when there is no percentage', () => {
    renderWithProviders(<PctCell pct={null} />)
    const cell = screen.getByText('—')
    expect(cell).toHaveAttribute('title', T('pages.slaReport.noObjectiveHint'))
  })

  it('keeps one decimal between 99 and 100, where the difference is the whole story', () => {
    renderWithProviders(<><PctCell pct={99.54} target={99.5} warning={98} /><PctCell pct={100} /><PctCell pct={87.4} /></>)
    const precise = screen.getByText('99.5%')
    expect(precise).toHaveAttribute('title', T('pages.slaReport.objectiveHint', { target: 99.5, warning: 98 }))
    expect(precise).toHaveStyle({ color: palette.success.text })
    // 100 and anything below 99 are rounded to the unit.
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('87%')).toBeInTheDocument()
  })
})

describe('WindowSelector', () => {
  it('offers the three windows, marks the chosen one and reports a click', async () => {
    const onChange = vi.fn()
    const { user } = renderWithProviders(<WindowSelector value={30} onChange={onChange} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(REPORT_WINDOWS.length)
    expect(screen.getByRole('button', { name: T('pages.slaReport.windowDays', { count: 30 }) })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: T('pages.slaReport.windowDays', { count: 7 }) })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: T('pages.slaReport.windowDays', { count: 90 }) }))
    expect(onChange).toHaveBeenCalledWith(90)
  })
})

describe('ReportSubheading', () => {
  it('renders its content as a heading', () => {
    renderWithProviders(<ReportSubheading>By priority</ReportSubheading>)
    expect(screen.getByRole('heading', { name: 'By priority' })).toBeInTheDocument()
  })
})

describe('ReportHeader', () => {
  const header = () => (
    <ReportHeader icon={<span />} title="OLA / UC Report" manageTo="/admin/ola-uc" manageLabel="Manage contracts" windowDays={7} onWindowChange={vi.fn()} />
  )

  it('shows the link to where the measure is configured to who may open that page', () => {
    perms.list = ['config.sla']
    renderWithProviders(header())
    expect(screen.getByRole('link', { name: 'Manage contracts' })).toHaveAttribute('href', '/admin/ola-uc')
    expect(screen.getByText('OLA / UC Report')).toBeInTheDocument()
  })

  it('hides the link from who could not open it, but keeps the window selector', () => {
    renderWithProviders(header())
    expect(screen.queryByRole('link', { name: 'Manage contracts' })).toBeNull()
    expect(screen.getByRole('button', { name: T('pages.slaReport.windowDays', { count: 7 }) })).toHaveAttribute('aria-pressed', 'true')
  })
})
