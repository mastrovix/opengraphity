/**
 * TIME AXES SHOW THE LABELS THAT FIT (D5, tour of 23 Sep 2026).
 *
 * «Incidents per month» — a full-width widget — read fine: month, and the
 * year at the year change. «Requests per month», the same chart at half the
 * width, drew all its forty labels on top of each other. The step between
 * shown labels now comes from the width the chart really has, is a round
 * number of periods, and the year goes to the first SHOWN label of each year.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { buildBarOption, buildLineOption, etichetteTemporali, passoEtichette, type ChartPoint } from '../echartsOptions'
import { resetCssVarCache } from '../cssVar'
import { setCssVars, CHART_CSS_VARS } from '@/test/utils'
import { useElementWidth } from '../useElementWidth'

/** Forty months, from Sep 2023 to Dec 2026: the demo tenant's «per month» sections. */
const MONTHS: ChartPoint[] = Array.from({ length: 40 }, (_, i) => {
  const d = new Date(Date.UTC(2023, 8 + i, 1))
  return { label: d.toISOString().slice(0, 10), value: i }
})

let cleanup: () => void
/** The bar chart also reads the categorical palette. */
const CSS_VARS: Record<string, string> = {
  ...CHART_CSS_VARS, '--color-white': '#ffffff', '--color-purple-light': '#8b5cf6', '--color-teal-light': '#06b6d4',
  '--color-lime': '#84cc16', '--color-teal': '#0891b2', '--color-pink': '#ec4899',
}
beforeEach(() => { resetCssVarCache(); cleanup = setCssVars(CSS_VARS) })
afterEach(() => { cleanup() })

type Axis = { data: string[]; axisLabel: { interval?: number; rotate?: number } }

describe('passoEtichette', () => {
  it('an unknown width changes nothing: every label, as before', () => {
    expect(passoEtichette(40, undefined, 4, 14)).toBe(1)
    expect(passoEtichette(40, 0, 4, 14)).toBe(1)
  })

  it('when they all fit, they are all shown', () => {
    expect(passoEtichette(12, 1000, 4, 14)).toBe(1)
  })

  it('when they do not, one in 2, 3, 4, 6 or 12: the labels fall on the same months every year', () => {
    const half = passoEtichette(40, 450, 4, 14)
    expect(half).toBeGreaterThan(1)
    expect([2, 3, 4, 6, 12]).toContain(half)
    const full = passoEtichette(40, 1000, 4, 14)
    expect(full).toBeLessThan(half)
  })

  it('a narrower chart never shows more labels than a wider one', () => {
    let previous = Infinity
    for (const width of [1400, 1000, 700, 450, 300, 200]) {
      const shown = Math.ceil(40 / passoEtichette(40, width, 4, 14))
      expect(shown).toBeLessThanOrEqual(previous)
      previous = shown
    }
  })
})

describe('etichetteTemporali with a step', () => {
  it('the year goes to the first SHOWN label of each year', () => {
    // Nov 2025 → Dec 2026, one in three shown: Nov, Feb, May, Aug, Nov.
    const labels = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10))
    const out = etichetteTemporali(labels, 'en', { passo: 3 })!
    expect([0, 3, 6, 9, 12].map((i) => out[i])).toEqual(['Nov\n2025', 'Feb\n2026', 'May', 'Aug', 'Nov'])
    // January is not shown: it does not take the year away from February.
    expect(out[2]).toBe('Jan')
  })

  it('a step of one is the old behaviour', () => {
    expect(etichetteTemporali(['2025-12-01', '2026-01-01'], 'en', { passo: 1 })).toEqual(['Dec\n2025', 'Jan\n2026'])
  })
})

describe('the builders', () => {
  it('a line over forty months at half width: labels thinned, not rotated, year where a label is shown', () => {
    const axis = buildLineOption(MONTHS, { showValueLabels: true, locale: 'en', larghezza: 450 }).xAxis as unknown as Axis
    const step = axis.axisLabel.interval! + 1
    expect(step).toBeGreaterThan(1)
    expect(axis.axisLabel.rotate).toBe(0)
    const shown = axis.data.filter((_, i) => i % step === 0)
    // Every year that appears among the shown labels is named once.
    const years = shown.map((l) => l.split('\n')[1]).filter(Boolean)
    expect(years).toEqual([...new Set(years)])
    expect(years[0]).toBe('2023')
  })

  it('a bar chart by month is thinned the same way (no more 30° rotation for dates)', () => {
    const axis = buildBarOption(MONTHS, { showValueLabels: true, locale: 'en', larghezza: 450 }).xAxis as unknown as Axis
    expect(axis.axisLabel.interval).toBeGreaterThan(0)
    expect(axis.axisLabel.rotate).toBe(0)
  })

  it('without a measured width a report chart keeps showing every label', () => {
    const axis = buildLineOption(MONTHS, { showValueLabels: true, locale: 'en' }).xAxis as unknown as Axis
    expect(axis.axisLabel.interval).toBe(0)
  })

  it('labels that are not dates are not touched by the width', () => {
    const words: ChartPoint[] = Array.from({ length: 8 }, (_, i) => ({ label: `L${String(i)}`, value: i }))
    expect((buildBarOption(words, { larghezza: 300 }).xAxis as unknown as Axis).axisLabel).toMatchObject({ interval: 0, rotate: 30 })
  })
})

describe('useElementWidth', () => {
  function Probe({ onWidth }: { onWidth: (w: number | undefined) => void }) {
    const [ref, width] = useElementWidth<HTMLDivElement>()
    onWidth(width)
    return <div ref={ref} />
  }

  it('reads the width before the first paint, and nothing when the element has none', () => {
    const seen: Array<number | undefined> = []
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 452.4 } as DOMRect)
    render(<Probe onWidth={(w) => seen.push(w)} />)
    expect(seen.at(-1)).toBe(452)
    spy.mockReturnValue({ width: 0 } as DOMRect)
    const empty: Array<number | undefined> = []
    render(<Probe onWidth={(w) => empty.push(w)} />)
    expect(empty.at(-1)).toBeUndefined()
    spy.mockRestore()
  })
})
