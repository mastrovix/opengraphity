/**
 * A HORIZONTAL BAR CHART GROUPED BY DATE.
 *
 * Its categories are dates (`2026-01-01`): they read as the other charts read
 * them — «Jan 2026», on one line, since a horizontal axis has room for one —
 * and in the list's order from the top down. A category that is not a date
 * stays as it is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildHorizontalBarOption } from './echartsOptions'
import { resetCssVarCache } from './cssVar'
import { setCssVars, CHART_CSS_VARS } from '@/test/utils'

const PALETTE_CSS_VARS: Record<string, string> = {
  ...CHART_CSS_VARS,
  '--color-purple-light': '#8b5cf6', '--color-teal-light': '#06b6d4', '--color-lime': '#84cc16',
  '--color-teal': '#0891b2', '--color-pink': '#ec4899', '--color-white': '#ffffff', '--color-black-a20': 'rgba(0, 0, 0, 0.20)',
}

let cleanup: () => void
beforeEach(() => { resetCssVarCache(); cleanup = setCssVars(PALETTE_CSS_VARS) })
afterEach(() => { cleanup() })

describe('buildHorizontalBarOption with dates', () => {
  it('months read as «month year» on one line, the first at the top', () => {
    const opt = buildHorizontalBarOption([{ label: '2026-01-01', value: 3 }, { label: '2026-02-01', value: 5 }], { locale: 'en', granularita: 'month' })
    expect(opt.yAxis.data).toEqual(['Feb 2026', 'Jan 2026'])
    // Each bar keeps its value next to its label.
    expect(opt.series[0]!.data.map((d) => d.value)).toEqual([5, 3])
  })

  it('categories that are not dates stay as they are', () => {
    const opt = buildHorizontalBarOption([{ label: 'high', value: 3 }, { label: 'low', value: 1 }], { locale: 'en' })
    expect(opt.yAxis.data).toEqual(['low', 'high'])
  })
})
