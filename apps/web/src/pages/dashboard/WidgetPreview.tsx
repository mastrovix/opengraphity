import { useState, useEffect } from 'react'
import type { PreviewData } from './useWidgetConfig'
import { TIME_RANGES } from './useWidgetConfig'

// ── Props ────────────────────────────────────────────────────────────────────

interface WidgetPreviewProps {
  widgetType:     string
  color:          string
  title:          string
  previewData:    PreviewData | null
  previewLoading: boolean
  timeRange:      string
}

// ── Component ────────────────────────────────────────────────────────────────

export function WidgetPreview({ widgetType, color, title, previewData, previewLoading, timeRange }: WidgetPreviewProps) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px 24px', background: '#f8fafc', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-slate-light)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 14 }}>
        Anteprima live
      </div>

      {/* Fake card */}
      <div style={{ background: '#fff', border: `2px solid ${color}33`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        {/* Card header */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', flex: 1 }}>
            {title || 'Titolo widget'}
          </span>
          {timeRange && timeRange !== 'all' && (
            <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate-light)' }}>
              {TIME_RANGES.find(t => t.value === timeRange)?.label}
            </span>
          )}
        </div>

        {/* Card body */}
        <InlinePreview
          widgetType={widgetType}
          color={color}
          title={title || 'Anteprima'}
          data={previewData}
          loading={previewLoading}
        />
      </div>

      {/* Stats */}
      {previewData && !previewLoading && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-slate-light)', display: 'flex', gap: 16 }}>
          {previewData.value != null && <span>Totale: <strong>{Math.round(previewData.value).toLocaleString('it-IT')}</strong></span>}
          {previewData.series.length > 0 && <span>Categorie: <strong>{previewData.series.length}</strong></span>}
        </div>
      )}

      {/* Spacer + hint */}
      <div style={{ flex: 1 }} />
      <div style={{ marginTop: 16, padding: 12, background: '#f0f9ff', borderRadius: 8, fontSize: 11, color: '#0369a1', lineHeight: 1.5 }}>
        {'\uD83D\uDCA1'} La preview si aggiorna automaticamente mentre configuri il widget (con debounce 600ms).
      </div>
    </div>
  )
}

// ── Inline Preview (counter / table / charts) ────────────────────────────────

function InlinePreview({
  widgetType, color, title, data, loading,
}: {
  widgetType: string
  color: string
  title: string
  data: PreviewData | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 28, height: 28, border: `3px solid ${color}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-slate-light)', fontSize: 13 }}>
        Configura le opzioni sopra per vedere l&apos;anteprima
      </div>
    )
  }

  if (widgetType === 'counter') {
    return (
      <div style={{ padding: '24px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 52, fontWeight: 700, color, lineHeight: 1 }}>
          {data.value != null ? Math.round(data.value).toLocaleString('it-IT') : '\u2014'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-slate-light)', marginTop: 8 }}>{title}</div>
      </div>
    )
  }

  if (widgetType === 'table') {
    return (
      <div style={{ maxHeight: 200, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              <th style={{ padding: '5px 10px', textAlign: 'left', color: 'var(--color-slate-light)', fontWeight: 600 }}>Label</th>
              <th style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--color-slate-light)', fontWeight: 600 }}>Valore</th>
            </tr>
          </thead>
          <tbody>
            {data.series.length === 0 ? (
              <tr><td colSpan={2} style={{ padding: '12px 10px', textAlign: 'center', color: 'var(--color-slate-light)' }}>Nessun dato</td></tr>
            ) : (
              data.series.map((s, i) => (
                <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '4px 10px', color: 'var(--color-slate-dark)' }}>{s.label}</td>
                  <td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 600, color }}>{s.value.toLocaleString('it-IT')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    )
  }

  // Bar / Pie / Line / Donut / Gauge — lazy-load ECharts
  return <EChartsPreview widgetType={widgetType} color={color} data={data} />
}

// ── Lazy ECharts ─────────────────────────────────────────────────────────────

type EChartsComponent = React.ComponentType<{ option: object; style?: React.CSSProperties; opts?: { renderer: string } }>

function EChartsPreview({ widgetType, color, data }: { widgetType: string; color: string; data: PreviewData }) {
  const [ReactECharts, setReactECharts] = useState<EChartsComponent | null>(null)

  useEffect(() => {
    import('echarts-for-react').then((m) => {
      const C = m.default as EChartsComponent
      setReactECharts(() => C)
    })
  }, [])

  if (!ReactECharts) return <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--color-slate-light)' }}>Caricamento grafico…</div>

  const palette = ['#0EA5E9','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#84cc16']

  let option: object

  if (widgetType === 'chart_bar') {
    option = {
      tooltip: { trigger: 'axis', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 11 } },
      grid: { top: 8, right: 8, bottom: 20, left: 36, containLabel: true },
      xAxis: { type: 'category', data: data.series.map(s => s.label), axisLabel: { fontSize: 10, color: '#64748b' } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#64748b' } },
      series: [{ type: 'bar', data: data.series.map(s => s.value), itemStyle: { color, borderRadius: [3,3,0,0] } }],
    }
  } else if (widgetType === 'chart_line') {
    option = {
      tooltip: { trigger: 'axis', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 11 } },
      grid: { top: 8, right: 8, bottom: 20, left: 36, containLabel: true },
      xAxis: { type: 'category', data: data.series.map(s => s.label), axisLabel: { fontSize: 10, color: '#64748b' } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#64748b' } },
      series: [{ type: 'line', data: data.series.map(s => s.value), smooth: true, lineStyle: { color }, itemStyle: { color }, areaStyle: { color: `${color}22` } }],
    }
  } else if (widgetType === 'chart_pie' || widgetType === 'chart_donut') {
    option = {
      tooltip: { trigger: 'item', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 11 }, formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'horizontal', bottom: 0, textStyle: { fontSize: 10, color: '#64748b' } },
      series: [{
        type: 'pie', radius: widgetType === 'chart_donut' ? ['38%','65%'] : '60%', center: ['50%','42%'],
        data: data.series.map((s, i) => ({ name: s.label, value: s.value, itemStyle: { color: palette[i % palette.length] } })),
        label: { show: false }, labelLine: { show: false },
      }],
    }
  } else {
    const val = Math.min(100, Math.max(0, data.value ?? 0))
    option = {
      series: [{
        type: 'gauge', startAngle: 200, endAngle: -20, min: 0, max: 100, splitNumber: 5,
        axisLine: { lineStyle: { width: 16, color: [[val/100, color],[1,'#e5e7eb']] } },
        pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        detail: { fontSize: 20, fontWeight: 600, color: 'var(--color-slate-dark)', formatter: `${Math.round(val)}%`, offsetCenter: [0,'20%'] },
        data: [{ value: val }],
      }],
    }
  }

  return <ReactECharts option={option} style={{ height: 180 }} opts={{ renderer: 'svg' }} />
}
