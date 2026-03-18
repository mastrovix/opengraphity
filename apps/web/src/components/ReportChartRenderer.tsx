import ReactECharts from 'echarts-for-react'

// ── Palette ───────────────────────────────────────────────────────────────────

const COLORS = [
  '#4f46e5', '#0891b2', '#059669',
  '#d97706', '#dc2626', '#7c3aed',
  '#0284c7', '#16a34a', '#ea580c',
  '#0d9488',
]

// ── Theme ─────────────────────────────────────────────────────────────────────

const BASE_TOOLTIP = {
  trigger: 'item' as const,
  backgroundColor: '#1e293b',
  borderColor: '#334155',
  borderWidth: 1,
  textStyle: { color: '#f1f5f9', fontSize: 12, fontFamily: 'Arial' },
  padding: [8, 12] as [number, number],
}

const BASE_LEGEND = {
  bottom: 0,
  textStyle: { color: '#64748b', fontSize: 12, fontFamily: 'Arial' },
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

export function ReportChartRenderer({ chartType, data, title, error }: Props) {
  if (error) {
    return (
      <div style={{
        padding: 16, borderRadius: 6,
        background: '#fef2f2', border: '1px solid #fecaca',
        color: '#dc2626', fontSize: 13,
      }}>
        {error}
      </div>
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return <div style={{ color: '#8892a4', fontSize: 13 }}>Dati non disponibili</div>
  }

  const echartsProps = { style: { height: 320, width: '100%' }, opts: { renderer: 'svg' as const }, theme: 'light' }

  switch (chartType) {

    case 'kpi': {
      const d = parsed as KpiData
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', gap: 8 }}>
          <div style={{ fontSize: 56, fontWeight: 800, color: '#4f46e5', lineHeight: 1, fontFamily: 'Arial' }}>
            {d.value?.toLocaleString('it-IT')}
          </div>
          <div style={{ fontSize: 14, color: '#64748b', fontFamily: 'Arial' }}>
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
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 11, color: '#374151' },
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
            style: { text: total.toLocaleString('it-IT'), fontSize: 24, fontWeight: 700, fill: '#1e293b' },
          },
          {
            type: 'text', left: 'center', top: '50%',
            style: { text: 'totale', fontSize: 12, fill: '#64748b' },
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
          label: { show: true, formatter: '{b}\n{d}%', fontSize: 11, color: '#374151' },
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
          axisLabel: { color: '#64748b', fontSize: 11, interval: 0, rotate: d.length > 6 ? 30 : 0 },
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value' as const,
          axisLabel: { color: '#64748b', fontSize: 11 },
          splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' as const } },
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
          label: { show: true, position: 'top' as const, color: '#374151', fontSize: 11, fontWeight: 600 },
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
          axisLabel: { color: '#64748b', fontSize: 11 },
          splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' as const } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'category' as const,
          data: d.map(item => item.name ?? item.label ?? '—').reverse(),
          axisLabel: { color: '#374151', fontSize: 12 },
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
          label: { show: true, position: 'right' as const, color: '#374151', fontSize: 11, fontWeight: 600 },
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
          axisLabel: { color: '#64748b', fontSize: 11 },
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value' as const,
          axisLabel: { color: '#64748b', fontSize: 11 },
          splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' as const } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [{
          type: 'line',
          data: d.map(item => item.value),
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: '#4f46e5', width: 2.5 },
          itemStyle: { color: '#4f46e5', borderWidth: 2, borderColor: '#fff' },
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
          axisLabel: { color: '#64748b', fontSize: 11 },
          axisLine: { lineStyle: { color: '#e2e8f0' } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value' as const,
          axisLabel: { color: '#64748b', fontSize: 11 },
          splitLine: { lineStyle: { color: '#f1f5f9', type: 'dashed' as const } },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [{
          type: 'line',
          data: d.map(item => item.value),
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: '#4f46e5', width: 2.5 },
          itemStyle: { color: '#4f46e5', borderWidth: 2, borderColor: '#fff' },
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
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Arial' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                {d.columns.map(col => (
                  <th key={col} style={{
                    textAlign: 'left', padding: '10px 14px',
                    fontSize: 11, fontWeight: 700, color: '#64748b',
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
                      padding: '10px 14px', fontSize: 13,
                      color: j === 0 ? '#1e293b' : '#374151',
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
      return <div style={{ color: '#8892a4', fontSize: 13 }}>Tipo grafico non supportato: {chartType}</div>
  }
}
