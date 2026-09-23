import ReactECharts from 'echarts-for-react'
import { useTranslation } from 'react-i18next'
import { BarChart2 } from 'lucide-react'
import { useElementWidth } from '@/lib/charts/useElementWidth'
import { fontFamily, colors, palette } from '@/lib/tokens'
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
  /** La chiave i18n dell'errore: se c'è, si legge quella. */
  errorKey?: string | null
  /** L'etichetta di un valore raggruppato (Dizionario, passi del workflow): giro del 14 set 2026, #11. */
  valueLabel?: (value: string) => string
  /**
   * Il periodo del raggruppamento (`day`/`week`/`month`/`year`), quando chi
   * disegna lo conosce: toglie l'indovinello sulle etichette temporali.
   */
  granularita?: string | null
}

// ── Component ─────────────────────────────────────────────────────────────────

function EmptyChart() {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', minHeight: 200, gap: 8 }}>
      <BarChart2 size={28} color="var(--color-slate)" />
      <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', fontWeight: 500 }}>
        {t('components.reportChart.unavailable')}
      </span>
    </div>
  )
}

function ChartError({ title, message }: { title: string; message: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', height: '100%', minHeight: 200, padding: '16px 20px', boxSizing: 'border-box' }}>
      <div style={{ padding: '10px 12px', backgroundColor: palette.danger.bg, border: `1px solid ${palette.danger.border}`, borderRadius: 6 }}>
        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: colors.danger, marginBottom: 4 }}>
          {title}
        </div>
        <div style={{ fontSize: 'var(--font-size-body)', color: colors.danger, wordBreak: 'break-word' }}>
          {message}
        </div>
      </div>
    </div>
  )
}

const REPORT_STYLE = { showValueLabels: true } as const

/**
 * A chart with a category axis that knows its width (D5): a time axis shows
 * the labels that fit — month and year at the year change — instead of all
 * of them on top of each other in a half-width widget.
 */
function GraficoAsse({ opzione }: { opzione: (larghezza: number | undefined) => object }) {
  const [ref, larghezza] = useElementWidth<HTMLDivElement>()
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <ReactECharts option={opzione(larghezza)} style={{ height: 320, width: '100%' }} opts={{ renderer: 'svg' }} theme="light" />
    </div>
  )
}

export function ReportChartRenderer({ chartType, data, title, error, errorKey, valueLabel, granularita }: Props) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  /*
   * Con la chiave si legge la frase nella lingua di chi guarda (20 set 2026):
   * l'anteprima mostrava «a table section needs at least one selected field
   * on a result node (isResult = true)» a chi usa il prodotto in italiano.
   * Senza chiave resta il messaggio tecnico, che per un difetto nostro è
   * l'unica cosa utile.
   */
  if (error) {
    const messaggio = errorKey && i18n.exists(errorKey) ? t(errorKey) : error
    return <ChartError title={t('components.reportChart.computeError')} message={messaggio} />
  }
  if (!data) return <EmptyChart />

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch (e) {
    return <ChartError title={t('components.reportChart.corruptData')} message={e instanceof Error ? e.message : String(e)} />
  }

  const echartsProps = { style: { height: 320, width: '100%' }, opts: { renderer: 'svg' as const }, theme: 'light' }
  const points = () => toPoints(parsed as LooseChartPoint[]).map((p) => (valueLabel ? { ...p, label: valueLabel(p.label) } : p))

  switch (chartType) {

    case 'kpi': {
      const d = parsed as KpiData
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', gap: 8 }}>
          <div style={{ fontSize: 56, fontWeight: 800, color: 'var(--color-brand)', lineHeight: 1, fontFamily }}>
            {d.value?.toLocaleString(locale)}
          </div>
          <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', fontFamily }}>
            {d.label ?? title}
          </div>
        </div>
      )
    }

    case 'pie':
      return <ReactECharts option={buildPieOption(points(), { ...REPORT_STYLE, locale: i18n.language, granularita })} {...echartsProps} />

    case 'donut': {
      const pts = points()
      const total = pts.reduce((s, p) => s + p.value, 0)
      return <ReactECharts option={buildPieOption(pts, { ...REPORT_STYLE, donut: true, centerText: total.toLocaleString(locale), locale: i18n.language, granularita })} {...echartsProps} />
    }

    case 'bar':
      return <GraficoAsse opzione={(larghezza) => buildBarOption(points(), { ...REPORT_STYLE, locale: i18n.language, granularita, larghezza })} />

    case 'bar_horizontal':
      return <ReactECharts option={buildHorizontalBarOption(points(), { ...REPORT_STYLE, locale: i18n.language, granularita })} {...echartsProps} />

    /*
     * LA CLASSIFICA si disegna come una barra ORIZZONTALE (19 set 2026).
     *
     * `top_n` era valido per l'API, coperto dai suoi test e reso da nessuno:
     * cadeva sul `default`, cioè «grafico non disponibile». Finché non si
     * poteva scegliere dalla UI il difetto era invisibile; offrendola, il 19
     * set, ho tolto una bugia («top_n» come nome del grafico) e ne ho messa
     * una peggiore — una scelta che il prodotto offre e non disegna.
     *
     * Orizzontale e non verticale perché una classifica si legge per nome: le
     * etichette stanno in riga, e il contratto dei dati è lo stesso delle
     * barre ({label, value} già ordinati e tagliati dal server).
     */
    case 'top_n':
      return <ReactECharts option={buildHorizontalBarOption(points(), { ...REPORT_STYLE, locale: i18n.language, granularita })} {...echartsProps} />

    case 'line':
      // `REPORT_STYLE` anche qui (20 set 2026): linea e area erano gli unici
      // due grafici che non lo ricevevano, quindi i punti restavano senza il
      // loro valore mentre barre e torte lo scrivevano.
      return <GraficoAsse opzione={(larghezza) => buildLineOption(points(), { ...REPORT_STYLE, locale: i18n.language, granularita, larghezza })} />

    case 'area':
      return <GraficoAsse opzione={(larghezza) => buildLineOption(points(), { ...REPORT_STYLE, area: true, locale: i18n.language, granularita, larghezza })} />

    case 'table': {
      const d = parsed as TableData
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily }}>
            <thead>
              <tr>
                {d.columns.map(col => (
                  <th key={col} style={{ textAlign: 'left', padding: '10px 14px', whiteSpace: 'nowrap' }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${palette.neutral.borderLight}`, background: i % 2 === 0 ? colors.white : palette.neutral.surface1 }}>
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
