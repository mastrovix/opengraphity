import { ReportChartRenderer } from './ReportChartRenderer'

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
}

export function ReportPreview({ loading, data, title, placeholder }: Props) {
  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 8, padding: 16,
      background: '#fafafa', minHeight: 220,
      display: 'flex',
      alignItems:     loading || !data ? 'center' : 'flex-start',
      justifyContent: loading || !data ? 'center' : 'flex-start',
    }}>
      {loading ? (
        <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Caricamento anteprima...</div>
      ) : data ? (
        <ReportChartRenderer
          chartType={data.chartType}
          data={data.data}
          title={title ?? data.title}
          error={data.error}
        />
      ) : (
        <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', textAlign: 'center' }}>
          {placeholder ?? "Configura il grafico per vedere l'anteprima"}
        </div>
      )}
    </div>
  )
}
