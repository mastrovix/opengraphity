import ReactECharts from 'echarts-for-react'
import { BarChart2 } from 'lucide-react'

// ── Palette ───────────────────────────────────────────────────────────────────

const COLORS = [
  'var(--color-brand)', '#0891b2', 'var(--color-trigger-automatic)',
  'var(--color-trigger-timer)', 'var(--color-trigger-sla-breach)', '#7c3aed',
  'var(--color-brand)', '#16a34a', 'var(--color-brand)',
  '#0d9488',
]

// ── Theme ─────────────────────────────────────────────────────────────────────

const BASE_TOOLTIP = {
  trigger: 'item' as const,
  backgroundColor: '#1e293b',
  borderColor: '#334155',
  borderWidth: 1,
  textStyle: { color: 'var(--color-slate-bg)', fontSize: 'var(--font-size-body)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" },
  padding: [8, 12] as [number, number],
}

const BASE_LEGEND = {
  bottom: 0,
  textStyle: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" },
  icon: 'circle',
  itemWidth: 8,
  itemHeight: 8,
}

// ── Data shapes ───────────────────────────────────────────────────────────────

interface KpiData   { value: number; label?: string }
interface LabelVal  { name?: string; label?: string; value: number }
interface TimeVal   { date?: string; label?: string; value: number }
interface TableData { columns: string[]; rows: unknown[][] }

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  chartType: string
  data:      string
  title:     string
  error?:    string | null
}

// ── Component ─────────────────────────────────────────────────────────────────

function EmptyChart() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', minHeight: 200, gap: 8 }}>
      <BarChart2 size={28} color="var(--color-slate)" />
      <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', fontWeight: 500 }}>
        Grafico non disponibile con i parametri selezionati
      </span>
    </div>
  )
}

export function ReportChartRenderer({ chartType, data, title, error }: Props) {
  if (error || !data) return <EmptyChart />

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return <EmptyChart />
  }

  const echartsProps = { style: { height: 320, width: '100%' }, opts: { renderer: 'svg' as const }, theme: 'light' }

  switch (chartType) {

    case 'kpi': {
      const d = parsed as KpiData
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', gap: 8 }}>
          <div style={{ fontSize: 56, fontWeight: 800, color: 'var(--color-brand)', lineHeight: 1, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
            {d.value?.toLocaleString('it-IT')}
          </div>
          <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
            {d.label ?? title}
          </div>
        </div>
      )
    }

    case 'pie': {
      const d = parsed as LabelVal[]
      const option = {
        tooltip: { ...BASE_TOOLTIP, formatter: '{b}: {c} ({d}%)' },
        legend: { ...BASE_LEGEND, type: 'scroll' as const },
        series: [{
          type: 'pie',
          radius: ['0%', '65%'],
          center: ['50%', '45%'],
          data: d.map((item, i) => ({
            name: item.name ?? item.label ?? '—',
            value: item.value,
            itemStyle: { color: COLORS[i % COLORS.length], borderRadius: 4, borderWidth: 2, borderColor: '#fff' },
          })),
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' },
          emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.2)' } },
        }],
      }
      return <ReactECharts option={option} {...echartsProps} />
    }

    case 'donut': {
      const d = parsed as LabelVal[]
      const total = d.reduce((s, item) => s + item.value, 0)
      const option = {
        tooltip: { ...BASE_TOOLTIP, formatter: '{b}: {c} ({d}%)' },
        legend: { ...BASE_LEGEND, type: 'scroll' as const },
        graphic: [
          {
            type: 'text', left: 'center', top: '40%',
            style: { text: total.toLocaleString('it-IT'), fontSize: 'var(--font-size-page-title)', fontWeight: 700, fill: '#1e293b' },
          },
          {
            type: 'text', left: 'center', top: '50%',
            style: { text: 'totale', fontSize: 'var(--font-size-body)', fill: 'var(--color-slate)' },
          },
        ],
        series: [{
          type: 'pie',
          radius: ['40%', '65%'],
          center: ['50%', '45%'],
          data: d.map((item, i) => ({
            name: item.name ?? item.label ?? '—',
            value: item.value,
            itemStyle: { color: COLORS[i % COLORS.length], borderRadius: 4, borderWidth: 2, borderColor: '#fff' },
          })),
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' },
          emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.2)' } },
        }],
      }
      return <ReactECharts option={option} {...echartsProps} />
    }

    case 'bar': {
      const d = parsed as LabelVal[]
      const option = {
        tooltip: { ...BASE_TOOLTIP, trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
        grid: { left: 16, right: 16, bottom: 48, top: 16, containLabel: true },
        xAxis: {
          type: 'category' as const,
          data: d.map(item => item.name ?? item.label ?? '—'),
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', interval: 0, rotate: d.length > 6 ? 30 : 0 },
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value' as const,
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' },
          splitLine: { lineStyle: { color: 'var(--color-slate-bg)', type: 'dashed' as const } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [{
          type: 'bar',
          data: d.map((item, i) => ({
            value: item.value,
            itemStyle: { color: COLORS[i % COLORS.length], borderRadius: [4, 4, 0, 0] },
          })),
          barMaxWidth: 48,
          label: { show: true, position: 'top' as const, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', fontWeight: 600 },
        }],
      }
      return <ReactECharts option={option} {...echartsProps} />
    }

    case 'bar_horizontal': {
      const d = parsed as LabelVal[]
      const option = {
        tooltip: { ...BASE_TOOLTIP, trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
        grid: { left: 16, right: 60, bottom: 16, top: 16, containLabel: true },
        xAxis: {
          type: 'value' as const,
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' },
          splitLine: { lineStyle: { color: 'var(--color-slate-bg)', type: 'dashed' as const } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'category' as const,
          data: d.map(item => item.name ?? item.label ?? '—').reverse(),
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' },
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisTick: { show: false },
        },
        series: [{
          type: 'bar',
          data: d.map((item, i) => ({
            value: item.value,
            itemStyle: { color: COLORS[i % COLORS.length], borderRadius: [0, 4, 4, 0] },
          })).reverse(),
          barMaxWidth: 32,
          label: { show: true, position: 'right' as const, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', fontWeight: 600 },
        }],
      }
      return <ReactECharts option={option} {...echartsProps} />
    }

    case 'line': {
      const d = parsed as TimeVal[]
      const option = {
        tooltip: { ...BASE_TOOLTIP, trigger: 'axis' as const },
        grid: { left: 16, right: 16, bottom: 48, top: 16, containLabel: true },
        xAxis: {
          type: 'category' as const,
          data: d.map(item => item.date ?? item.label),
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' },
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value' as const,
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' },
          splitLine: { lineStyle: { color: 'var(--color-slate-bg)', type: 'dashed' as const } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [{
          type: 'line',
          data: d.map(item => item.value),
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: 'var(--color-brand)', width: 2.5 },
          itemStyle: { color: 'var(--color-brand)', borderWidth: 2, borderColor: '#fff' },
        }],
      }
      return <ReactECharts option={option} {...echartsProps} />
    }

    case 'area': {
      const d = parsed as TimeVal[]
      const option = {
        tooltip: { ...BASE_TOOLTIP, trigger: 'axis' as const },
        grid: { left: 16, right: 16, bottom: 48, top: 16, containLabel: true },
        xAxis: {
          type: 'category' as const,
          data: d.map(item => item.date ?? item.label),
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' },
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value' as const,
          axisLabel: { color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' },
          splitLine: { lineStyle: { color: 'var(--color-slate-bg)', type: 'dashed' as const } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [{
          type: 'line',
          data: d.map(item => item.value),
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: 'var(--color-brand)', width: 2.5 },
          itemStyle: { color: 'var(--color-brand)', borderWidth: 2, borderColor: '#fff' },
          areaStyle: {
            color: {
              type: 'linear' as const,
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(79,70,229,0.2)' },
                { offset: 1, color: 'rgba(79,70,229,0.02)' },
              ],
            },
          },
        }],
      }
      return <ReactECharts option={option} {...echartsProps} />
    }

    case 'table': {
      const d = parsed as TableData
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                {d.columns.map(col => (
                  <th key={col} style={{
                    textAlign: 'left', padding: '10px 14px',
                    fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate)',
                    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                  }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9', background: i % 2 === 0 ? '#fff' : '#fafafe' }}>
                  {(row as unknown[]).map((cell, j) => (
                    <td key={j} style={{
                      padding: '10px 14px', fontSize: 'var(--font-size-card-title)',
                      color: j === 0 ? '#1e293b' : 'var(--color-slate)',
                      fontWeight: j === 0 ? 500 : 400,
                    }}>
                      {String(cell ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    default:
      return <EmptyChart />
  }
}
