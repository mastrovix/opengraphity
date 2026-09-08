import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  toPoints, chartPalette, buildBarOption, buildHorizontalBarOption, buildLineOption, buildPieOption, buildGaugeOption,
  type ChartPoint,
} from './echartsOptions'
import { resetCssVarCache } from './cssVar'
import { setCssVars, CHART_CSS_VARS } from '@/test/utils'

const POINTS: ChartPoint[] = [
  { label: 'A', value: 3 }, { label: 'B', value: 5 }, { label: 'C', value: 1 },
]
const MANY: ChartPoint[] = Array.from({ length: 8 }, (_, i) => ({ label: `L${i}`, value: i }))

let cleanup: () => void
beforeEach(() => { resetCssVarCache(); cleanup = setCssVars(CHART_CSS_VARS) })
afterEach(() => { cleanup() })

describe('toPoints', () => {
  it('precedenza date > name > label, altrimenti "—"', () => {
    expect(toPoints([
      { date: '2026-09', name: 'n', label: 'l', value: 1 },
      { name: 'n', label: 'l', value: 2 },
      { label: 'l', value: 3 },
      { value: 4 },
    ])).toEqual([
      { label: '2026-09', value: 1 }, { label: 'n', value: 2 }, { label: 'l', value: 3 }, { label: '—', value: 4 },
    ])
  })
})

describe('chartPalette', () => {
  it('10 colori tutti distinti, il primo è il brand', () => {
    const p = chartPalette()
    expect(p).toHaveLength(10)
    expect(new Set(p).size).toBe(10)
    expect(p[0]).toBe(CHART_CSS_VARS['--color-brand'])
    for (const c of p) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('senza token CSS lancia (nessuna palette di ripiego)', () => {
    cleanup(); resetCssVarCache()
    expect(() => chartPalette()).toThrow(/\[cssVar\]/)
  })
})

describe('buildBarOption', () => {
  it('asse categoria con le etichette, un colore per barra dalla palette, font in px', () => {
    const opt = buildBarOption(POINTS)
    expect(opt.xAxis.type).toBe('category')
    expect(opt.xAxis.data).toEqual(['A', 'B', 'C'])
    expect(opt.yAxis.type).toBe('value')
    const palette = chartPalette()
    expect(opt.series[0]!.data.map((d) => d.itemStyle.color)).toEqual(palette.slice(0, 3))
    expect(opt.series[0]!.data.map((d) => d.value)).toEqual([3, 5, 1])
    expect(opt.xAxis.axisLabel.fontSize).toBe(14)
    expect(opt.xAxis.axisLabel.fontFamily).toBe('Inter, sans-serif')
    expect(opt.tooltip.backgroundColor).toBe('#0f172a')
    expect(opt.series[0]!.label.show).toBe(false)
  })

  it('più di 6 punti → etichette ruotate di 30°; compact → font tabella e nessuna rotazione', () => {
    expect(buildBarOption(MANY).xAxis.axisLabel).toMatchObject({ rotate: 30, interval: 0 })
    expect(buildBarOption(POINTS).xAxis.axisLabel).toMatchObject({ rotate: 0 })
    const compact = buildBarOption(MANY, { compact: true })
    expect(compact.xAxis.axisLabel.fontSize).toBe(12)
    expect(compact.xAxis.axisLabel).not.toHaveProperty('rotate')
    expect(compact.grid).toEqual({ top: 12, right: 12, bottom: 20, left: 40, containLabel: true })
  })

  it('color forza un colore unico; showValueLabels attiva le etichette valore', () => {
    const opt = buildBarOption(POINTS, { color: '#123456', showValueLabels: true })
    expect(opt.series[0]!.data.every((d) => d.itemStyle.color === '#123456')).toBe(true)
    expect(opt.series[0]!.label).toMatchObject({ show: true, position: 'top', fontSize: 14 })
  })
})

describe('buildHorizontalBarOption', () => {
  it('inverte l\'ordine (prima riga in alto) mantenendo il colore associato al punto', () => {
    const opt = buildHorizontalBarOption(POINTS)
    const palette = chartPalette()
    expect(opt.yAxis.data).toEqual(['C', 'B', 'A'])
    expect(opt.xAxis.type).toBe('value')
    // il punto A (indice 0 originale) resta palette[0] anche se ora è l'ultimo
    expect(opt.series[0]!.data.at(-1)!.itemStyle.color).toBe(palette[0])
    expect(opt.series[0]!.data[0]!.itemStyle.color).toBe(palette[2])
  })
})

describe('buildLineOption', () => {
  it('serie lineare con colore brand di default e area opzionale', () => {
    const opt = buildLineOption(POINTS)
    expect(opt.series[0]!.data).toEqual([3, 5, 1])
    expect(opt.series[0]!.lineStyle.color).toBe(CHART_CSS_VARS['--color-brand'])
    expect(opt.series[0]).not.toHaveProperty('areaStyle')
    const area = buildLineOption(POINTS, { area: true, color: '#abcdef' })
    expect(area.series[0]).toHaveProperty('areaStyle')
    expect(area.series[0]!.lineStyle.color).toBe('#abcdef')
  })
})

describe('buildPieOption', () => {
  it('fette con nome/valore e palette; donut con testo centrale', () => {
    const pie = buildPieOption(POINTS)
    expect(pie.series[0]!.data.map((d) => d.name)).toEqual(['A', 'B', 'C'])
    expect(pie.series[0]!.radius).toEqual(['0%', '65%'])
    expect(pie).not.toHaveProperty('graphic')
    expect(pie.legend.bottom).toBe(0)

    const donut = buildPieOption(POINTS, { donut: true, centerText: '9' })
    expect(donut.series[0]!.radius).toEqual(['40%', '65%'])
    expect(donut.graphic?.[0]?.style.text).toBe('9')
    expect(donut.graphic?.[0]?.style.fontSize).toBe(24)
    expect(donut.graphic?.[1]?.style.text).toBe('totale')
  })

  it('più fette della palette → i colori ciclano', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `s${i}`, value: 1 }))
    const pie = buildPieOption(many)
    const palette = chartPalette()
    expect(pie.series[0]!.data[10]!.itemStyle.color).toBe(palette[0])
    expect(pie.series[0]!.data[11]!.itemStyle.color).toBe(palette[1])
  })
})

describe('buildGaugeOption', () => {
  it.each([
    [null, 0], [-20, 0], [0, 0], [42.4, 42], [100, 100], [250, 100],
  ])('valore %s → %d% (clamp 0–100)', (input, pct) => {
    const g = buildGaugeOption(input)
    expect(g.series[0]!.detail.formatter).toBe(`${pct}%`)
    expect(g.series[0]!.data[0]!.value).toBe(Math.min(100, Math.max(0, input ?? 0)))
  })
  it('l\'arco colorato è proporzionale al valore, il resto è bordo', () => {
    const g = buildGaugeOption(25, { color: '#00ff00' })
    expect(g.series[0]!.axisLine.lineStyle.color).toEqual([[0.25, '#00ff00'], [1, CHART_CSS_VARS['--color-border']]])
  })
})
