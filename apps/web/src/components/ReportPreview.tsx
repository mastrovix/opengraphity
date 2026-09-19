import { useTranslation } from 'react-i18next'
import { ReportChartRenderer } from './ReportChartRenderer'
import { colors, palette } from '@/lib/tokens'

export interface SectionResult {
  sectionId:  string
  title:      string
  chartType:  string
  data:       string
  total:      number | null
  error:      string | null
}

interface Props {
  loading:     boolean
  data:        SectionResult | null
  title?:      string
  placeholder?: string
  /** Il periodo del raggruppamento: lo sa il costruttore, e toglie l'indovinello sulle date. */
  granularita?: string | null
}

export function ReportPreview({ loading, data, title, placeholder, granularita }: Props) {
  const { t } = useTranslation()
  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: 8, padding: 16,
      background: palette.neutral.surface1, minHeight: 220,
      display: 'flex',
      alignItems:     loading || !data ? 'center' : 'flex-start',
      justifyContent: loading || !data ? 'center' : 'flex-start',
    }}>
      {loading ? (
        <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('reportBuilder.loadingPreview')}</div>
      ) : data ? (
        <ReportChartRenderer
          chartType={data.chartType}
          data={data.data}
          title={title ?? data.title}
          error={data.error}
          granularita={granularita}
        />
      ) : (
        <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', textAlign: 'center' }}>
          {placeholder ?? t('reportChart.configureToPreview')}
        </div>
      )}
    </div>
  )
}
