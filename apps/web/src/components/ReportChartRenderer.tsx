import ReactECharts from 'echarts-for-react'
import { BarChart2 } from 'lucide-react'
import { fontFamily } from '@/lib/tokens'
import {
  buildBarOption, buildHorizontalBarOption, buildLineOption, buildPieOption, toPoints,
  type LooseChartPoint,
} from '@/lib/charts/echartsOptions'

// ── Data shapes ───────────────────────────────────────────────────────────────

interface KpiData   { value: number; label?: string }
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

function ChartError({ title, message }: { title: string; message: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', height: '100%', minHeight: 200, padding: '16px 20px', boxSizing: 'border-box' }}>
      <div style={{ padding: '10px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6 }}>
        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-danger, #ef4444)', marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-danger, #ef4444)', wordBreak: 'break-word' }}>
          {message}
        </div>
      </div>
    </div>
  )
}

const REPORT_STYLE = { showValueLabels: true } as const

export function ReportChartRenderer({ chartType, data, title, error }: Props) {
  if (error) return <ChartError title="Errore nel calcolo della sezione" message={error} />
  if (!data) return <EmptyChart />

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (e) {
    return <ChartError title="Dati sezione corrotti" message={e instanceof Error ? e.message : String(e)} />
  }

  const echartsProps = { style: { height: 320, width: '100%' }, opts: { renderer: 'svg' as const }, theme: 'light' }
  const points = () => toPoints(parsed as LooseChartPoint[])

  switch (chartType) {

    case 'kpi': {
      const d = parsed as KpiData
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', gap: 8 }}>
          <div style={{ fontSize: 56, fontWeight: 800, color: 'var(--color-brand)', lineHeight: 1, fontFamily }}>
            {d.value?.toLocaleString('it-IT')}
          </div>
          <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', fontFamily }}>
            {d.label ?? title}
          </div>
        </div>
      )
    }

    case 'pie':
      return <ReactECharts option={buildPieOption(points(), REPORT_STYLE)} {...echartsProps} />

    case 'donut': {
      const pts = points()
      const total = pts.reduce((s, p) => s + p.value, 0)
      return <ReactECharts option={buildPieOption(pts, { ...REPORT_STYLE, donut: true, centerText: total.toLocaleString('it-IT') })} {...echartsProps} />
    }

    case 'bar':
      return <ReactECharts option={buildBarOption(points(), REPORT_STYLE)} {...echartsProps} />

    case 'bar_horizontal':
      return <ReactECharts option={buildHorizontalBarOption(points(), REPORT_STYLE)} {...echartsProps} />

    case 'line':
      return <ReactECharts option={buildLineOption(points())} {...echartsProps} />

    case 'area':
      return <ReactECharts option={buildLineOption(points(), { area: true })} {...echartsProps} />

    case 'table': {
      const d = parsed as TableData
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily }}>
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
                      color: j === 0 ? 'var(--color-slate-dark)' : 'var(--color-slate)',
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
