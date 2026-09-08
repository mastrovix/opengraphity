/**
 * Corpo di un widget dashboard (counter / tabella / grafici ECharts).
 *
 * Unico per la card reale (CustomWidgetCard) e per l'anteprima del
 * configuratore (WidgetPreview): prima l'anteprima reimplementava counter,
 * tabella e i quattro grafici con opzioni leggermente diverse, quindi ciò che
 * si vedeva configurando non era ciò che compariva in dashboard.
 *
 * Importa ECharts staticamente: chi vuole il lazy-load (il modal di
 * configurazione) fa `lazy(() => import('@/components/WidgetBody'))`.
 */
import ReactECharts from 'echarts-for-react'
import { useTranslation } from 'react-i18next'
import { lookupOrError } from '@/lib/tokens'
import {
  buildBarOption, buildGaugeOption, buildLineOption, buildPieOption, type ChartPoint,
} from '@/lib/charts/echartsOptions'

export interface WidgetSeriesData {
  value:  number | null
  label:  string | null
  series: { label: string; value: number; color?: string | null }[]
}

interface Props {
  widgetType: string
  color:      string
  data:       WidgetSeriesData
  /** Sottotitolo del counter (es. "Status: open" o il tipo entità). */
  caption?:   string
  /** Altezza dei grafici in px. */
  height?:    number
  /** Counter più grande (anteprima). */
  large?:     boolean
}

type ChartKind = 'bar' | 'line' | 'pie' | 'donut' | 'gauge'

const CHART_KIND: Record<string, ChartKind> = {
  chart_bar: 'bar', chart_line: 'line', chart_pie: 'pie', chart_donut: 'donut', gauge: 'gauge',
}

function buildOption(kind: ChartKind, points: ChartPoint[], data: WidgetSeriesData, color: string): object {
  switch (kind) {
    case 'bar':   return buildBarOption(points, { color, compact: true })
    case 'line':  return buildLineOption(points, { color, compact: true, area: true })
    case 'pie':   return buildPieOption(points, { compact: true })
    case 'donut': return buildPieOption(points, { compact: true, donut: true })
    case 'gauge': return buildGaugeOption(data.value, { color })
  }
}

export function WidgetBody({ widgetType, color, data, caption, height = 180, large = false }: Props) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language

  if (widgetType === 'counter') {
    return (
      <div style={{ padding: large ? '24px 20px' : '20px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: large ? 52 : 42, fontWeight: 700, color, lineHeight: 1 }}>
          {data.value != null ? Math.round(data.value).toLocaleString(locale) : '—'}
        </div>
        {caption && (
          <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: large ? 8 : 6 }}>
            {caption}
          </div>
        )}
      </div>
    )
  }

  if (widgetType === 'table') {
    return (
      <div style={{ overflow: 'auto', maxHeight: 220 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
          <thead>
            <tr style={{ background: 'var(--color-slate-bg)' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--color-slate-light)', fontWeight: 600 }}>{t('components.widgetBody.label')}</th>
              <th style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--color-slate-light)', fontWeight: 600 }}>{t('components.widgetBody.value')}</th>
            </tr>
          </thead>
          <tbody>
            {data.series.length === 0 ? (
              <tr><td colSpan={2} style={{ padding: '12px 10px', textAlign: 'center', color: 'var(--color-slate-light)' }}>{t('components.widgetBody.noData')}</td></tr>
            ) : data.series.map((s, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={{ padding: '5px 10px', color: 'var(--color-slate-dark)' }}>{s.label}</td>
                <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600, color }}>{s.value.toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const kind = lookupOrError(CHART_KIND, widgetType, 'CHART_KIND', 'bar')
  const points: ChartPoint[] = data.series.map((s) => ({ label: s.label, value: s.value }))
  return (
    <ReactECharts
      option={buildOption(kind, points, data, color)}
      style={{ height: kind === 'gauge' ? Math.min(height, 160) : height }}
      opts={{ renderer: 'svg' }}
    />
  )
}
