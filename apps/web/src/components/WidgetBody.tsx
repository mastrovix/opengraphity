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
import { lookupOrError, palette } from '@/lib/tokens'
import { useElementWidth } from '@/lib/charts/useElementWidth'
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

function buildOption(kind: ChartKind, points: ChartPoint[], data: WidgetSeriesData, color: string, larghezza: number | undefined): object {
  switch (kind) {
    // D5: a time axis shows the labels its measured width holds.
    case 'bar':   return buildBarOption(points, { color, compact: true, larghezza })
    case 'line':  return buildLineOption(points, { color, compact: true, area: true, larghezza })
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
        <div className="og-scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
          <thead>
            <tr>
              <th style={{ padding: '6px 10px', textAlign: 'left' }}>{t('components.widgetBody.label')}</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }}>{t('components.widgetBody.value')}</th>
            </tr>
          </thead>
          <tbody>
            {data.series.length === 0 ? (
              <tr><td colSpan={2} style={{ padding: '12px 10px', textAlign: 'center', color: 'var(--color-slate-light)' }}>{t('components.widgetBody.noData')}</td></tr>
            ) : data.series.map((s, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${palette.neutral.borderLight}` }}>
                <td style={{ padding: '5px 10px', color: 'var(--color-slate-dark)' }}>{s.label}</td>
                <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600, color }}>{s.value.toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    )
  }

  return <WidgetChart widgetType={widgetType} color={color} data={data} height={height} />
}

/** The chart of a widget, which knows its width (D5): hooks live here, after the counter and table returns. */
function WidgetChart({ widgetType, color, data, height }: { widgetType: string; color: string; data: WidgetSeriesData; height: number }) {
  const [ref, larghezza] = useElementWidth<HTMLDivElement>()
  const kind = lookupOrError(CHART_KIND, widgetType, 'CHART_KIND', 'bar')
  const points: ChartPoint[] = data.series.map((s) => ({ label: s.label, value: s.value }))
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <ReactECharts
        option={buildOption(kind, points, data, color, larghezza)}
        style={{ height: kind === 'gauge' ? Math.min(height, 160) : height }}
        opts={{ renderer: 'svg' }}
      />
    </div>
  )
}
