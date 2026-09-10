/**
 * Builder ECharts condivisi — unica palette, unico tema.
 *
 * Prima esistevano tre renderer (CustomWidgetCard, WidgetPreview,
 * ReportChartRenderer) con palette duplicate (e `var(--color-brand)` ripetuto
 * tre volte nella stessa palette → fette di torta dello stesso colore), gauge
 * scritto due volte e look diverso tra anteprima e widget reale.
 *
 * I token CSS vengono risolti a runtime con `cssVar` perché ECharts vuole
 * numeri/hex, non `var(--…)`.
 */
import { cssVar, cssVarPx } from './cssVar'

// ── Dati ─────────────────────────────────────────────────────────────────────

export interface ChartPoint { label: string; value: number }

/** Voci dei report: il server può usare `name` o `label`, `date` per le serie temporali. */
export interface LooseChartPoint { name?: string; label?: string; date?: string; value: number }

export function toPoints(items: LooseChartPoint[]): ChartPoint[] {
  return items.map((it) => ({ label: it.date ?? it.name ?? it.label ?? '—', value: it.value }))
}

// ── Tema (lazy: i token esistono solo nel browser) ───────────────────────────

function theme() {
  return {
    font:        cssVar('--font-family'),
    textDark:    cssVar('--color-slate-dark'),
    text:        cssVar('--color-slate'),
    textLight:   cssVar('--color-slate-light'),
    tooltipBg:   cssVar('--color-slate-dark'),
    tooltipText: cssVar('--color-slate-bg'),
    grid:        cssVar('--color-slate-bg'),
    border:      cssVar('--color-border'),
    brand:       cssVar('--color-brand'),
    fsBody:      cssVarPx('--font-size-body'),
    fsTable:     cssVarPx('--font-size-table'),
    fsTitle:     cssVarPx('--font-size-page-title'),
  }
}

/** Palette categorica unica (10 colori distinti, niente duplicati). */
export function chartPalette(): string[] {
  return [
    cssVar('--color-brand'),
    cssVar('--color-trigger-automatic'),
    cssVar('--color-warning'),
    cssVar('--color-danger'),
    cssVar('--color-purple-light'),
    cssVar('--color-teal-light'),
    cssVar('--color-lime'),
    cssVar('--color-trigger-timer'),
    cssVar('--color-teal'),
    cssVar('--color-pink'),
  ]
}

export interface ChartStyle {
  /** Colore unico della serie (widget); se assente si usa la palette per elemento. */
  color?: string
  /** Etichette valore sulle barre / fette (report). */
  showValueLabels?: boolean
  /** Layout più stretto (card dashboard). */
  compact?: boolean
}

function tooltip(trigger: 'item' | 'axis', extra: Record<string, unknown> = {}) {
  const t = theme()
  return {
    trigger,
    backgroundColor: t.tooltipBg,
    borderColor: t.tooltipBg,
    borderWidth: 1,
    textStyle: { color: t.tooltipText, fontSize: t.fsBody, fontFamily: t.font },
    padding: [8, 12],
    ...extra,
  }
}

function axisLabel(compact: boolean, extra: Record<string, unknown> = {}) {
  const t = theme()
  return { color: t.text, fontSize: compact ? t.fsTable : t.fsBody, fontFamily: t.font, ...extra }
}

function categoryAxis(labels: string[], compact: boolean, rotate = 0) {
  const t = theme()
  return {
    type: 'category' as const,
    data: labels,
    axisLabel: axisLabel(compact, compact ? {} : { interval: 0, rotate }),
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
  }
}

function valueAxis(compact: boolean) {
  const t = theme()
  return {
    type: 'value' as const,
    axisLabel: axisLabel(compact),
    splitLine: { lineStyle: { color: t.grid, type: 'dashed' as const } },
    axisLine: { show: false },
    axisTick: { show: false },
  }
}

function legend(compact: boolean) {
  const t = theme()
  return {
    bottom: 0,
    type: 'scroll' as const,
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { color: t.text, fontSize: compact ? t.fsTable : t.fsBody, fontFamily: t.font },
  }
}

function itemColor(style: ChartStyle, i: number, palette: string[]): string {
  return style.color ?? palette[i % palette.length]!
}

// ── Builder ──────────────────────────────────────────────────────────────────

export function buildBarOption(points: ChartPoint[], style: ChartStyle = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const palette = chartPalette()
  return {
    tooltip: tooltip('axis', { axisPointer: { type: 'shadow' } }),
    grid: compact
      ? { top: 12, right: 12, bottom: 20, left: 40, containLabel: true }
      : { left: 16, right: 16, bottom: 48, top: 16, containLabel: true },
    xAxis: categoryAxis(points.map((p) => p.label), compact, points.length > 6 ? 30 : 0),
    yAxis: valueAxis(compact),
    series: [{
      type: 'bar',
      data: points.map((p, i) => ({ value: p.value, itemStyle: { color: itemColor(style, i, palette), borderRadius: [4, 4, 0, 0] } })),
      barMaxWidth: 48,
      label: style.showValueLabels
        ? { show: true, position: 'top', color: t.text, fontSize: t.fsBody, fontWeight: 600, fontFamily: t.font }
        : { show: false },
    }],
  }
}

export function buildHorizontalBarOption(points: ChartPoint[], style: ChartStyle = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const palette = chartPalette()
  const rev = [...points].reverse()
  return {
    tooltip: tooltip('axis', { axisPointer: { type: 'shadow' } }),
    grid: { left: 16, right: 60, bottom: 16, top: 16, containLabel: true },
    xAxis: valueAxis(compact),
    yAxis: { ...categoryAxis(rev.map((p) => p.label), compact), axisLine: { lineStyle: { color: t.border } } },
    series: [{
      type: 'bar',
      data: rev.map((p, i) => ({ value: p.value, itemStyle: { color: itemColor(style, rev.length - 1 - i, palette), borderRadius: [0, 4, 4, 0] } })),
      barMaxWidth: 32,
      label: style.showValueLabels
        ? { show: true, position: 'right', color: t.text, fontSize: t.fsBody, fontWeight: 600, fontFamily: t.font }
        : { show: false },
    }],
  }
}

export function buildLineOption(points: ChartPoint[], style: ChartStyle & { area?: boolean } = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const color = style.color ?? t.brand
  return {
    tooltip: tooltip('axis'),
    grid: compact
      ? { top: 12, right: 12, bottom: 20, left: 40, containLabel: true }
      : { left: 16, right: 16, bottom: 48, top: 16, containLabel: true },
    xAxis: categoryAxis(points.map((p) => p.label), compact),
    yAxis: valueAxis(compact),
    series: [{
      type: 'line',
      data: points.map((p) => p.value),
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { color, width: 2.5 },
      itemStyle: { color, borderWidth: 2, borderColor: cssVar('--color-white') },
      ...(style.area
        ? { areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${color}33` }, { offset: 1, color: `${color}05` }] } } }
        : {}),
    }],
  }
}

export function buildPieOption(points: ChartPoint[], style: ChartStyle & { donut?: boolean; centerText?: string } = {}) {
  const t = theme()
  const compact = style.compact ?? false
  const palette = chartPalette()
  const donut = style.donut ?? false
  return {
    tooltip: tooltip('item', { formatter: '{b}: {c} ({d}%)' }),
    legend: legend(compact),
    ...(donut && style.centerText !== undefined
      ? {
          graphic: [
            { type: 'text', left: 'center', top: '40%', style: { text: style.centerText, fontSize: t.fsTitle, fontWeight: 700, fill: t.textDark, fontFamily: t.font } },
            { type: 'text', left: 'center', top: '50%', style: { text: 'totale', fontSize: t.fsBody, fill: t.text, fontFamily: t.font } },
          ],
        }
      : {}),
    series: [{
      type: 'pie',
      radius: donut ? (compact ? ['40%', '70%'] : ['40%', '65%']) : (compact ? '65%' : ['0%', '65%']),
      center: ['50%', '45%'],
      data: points.map((p, i) => ({
        name: p.label,
        value: p.value,
        itemStyle: { color: palette[i % palette.length], borderRadius: 4, borderWidth: 2, borderColor: cssVar('--color-white') },
      })),
      label: style.showValueLabels
        ? { show: true, formatter: '{b}\n{d}%', fontSize: t.fsBody, color: t.text, fontFamily: t.font }
        : { show: false },
      labelLine: { show: style.showValueLabels ?? false },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: cssVar('--color-black-a20') } },
    }],
  }
}

/** Percentuale 0–100 su arco a 220°. */
export function buildGaugeOption(value: number | null, style: ChartStyle = {}) {
  const t = theme()
  const val = Math.min(100, Math.max(0, value ?? 0))
  const color = style.color ?? t.brand
  return {
    series: [{
      type: 'gauge', startAngle: 200, endAngle: -20,
      min: 0, max: 100, splitNumber: 5,
      axisLine: { lineStyle: { width: 18, color: [[val / 100, color], [1, t.border]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      detail: { fontSize: t.fsTitle, fontWeight: 600, color: t.textDark, fontFamily: t.font, formatter: `${Math.round(val)}%`, offsetCenter: [0, '20%'] },
      data: [{ value: val }],
    }],
  }
}
