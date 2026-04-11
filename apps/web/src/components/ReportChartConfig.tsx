import {
  Hash, PieChart, CircleDot, BarChart2, BarChart, LineChart, TrendingUp,
  Table as TableIcon,
} from 'lucide-react'
import { ReportPreview } from './ReportPreview'
import type { SectionResult } from './ReportPreview'
import type { NavigableField } from './ReportFlowNodes'

export const CHART_TYPES = [
  { value: 'kpi',            label: 'Numero totale',     desc: 'Quanti elementi ci sono?',       icon: <Hash size={18} /> },
  { value: 'pie',            label: 'Torta',             desc: 'Distribuzione in percentuale',    icon: <PieChart size={18} /> },
  { value: 'donut',          label: 'Donut',             desc: 'Distribuzione ad anello',         icon: <CircleDot size={18} /> },
  { value: 'bar',            label: 'Barre verticali',   desc: 'Confronto tra categorie',         icon: <BarChart2 size={18} /> },
  { value: 'bar_horizontal', label: 'Barre orizzontali', desc: 'Confronto con etichette lunghe',  icon: <BarChart size={18} /> },
  { value: 'line',           label: 'Linea',             desc: 'Andamento nel tempo',             icon: <LineChart size={18} /> },
  { value: 'area',           label: 'Area',              desc: 'Andamento con riempimento',       icon: <TrendingUp size={18} /> },
  { value: 'table',          label: 'Tabella',           desc: 'Dati dettagliati con colonne',    icon: <TableIcon size={18} /> },
]

export const METRIC_TYPES = [
  { value: 'count', label: 'Conteggio' },
  { value: 'avg',   label: 'Media' },
  { value: 'sum',   label: 'Somma' },
  { value: 'min',   label: 'Minimo' },
  { value: 'max',   label: 'Massimo' },
]

export const DATE_FIELD_NAMES = ['created_at', 'updated_at', 'resolved_at', 'expires_at', 'scheduled_start', 'scheduled_end', 'implemented_at']

interface NodeDataEntry {
  label:          string
  fields:         NavigableField[]
  selectedFields: string[]
  isResult:       boolean
}

interface Props {
  chartType:              string
  onChartTypeChange:      (v: string) => void
  metric:                 string
  onMetricChange:         (v: string) => void
  metricField:            string
  onMetricFieldChange:    (v: string) => void
  groupByNodeId:          string
  onGroupByNodeIdChange:  (v: string) => void
  groupByField:           string
  onGroupByFieldChange:   (v: string) => void
  limit:                  number
  onLimitChange:          (v: number) => void
  sortDir:                string
  onSortDirChange:        (v: string) => void
  nodeDataMap:            Record<string, NodeDataEntry>
  onSelectedFieldsChange: (nodeId: string, fields: string[]) => void
  step3DateFields:        NavigableField[]
  previewLoading:         boolean
  previewData:            SectionResult | null
}

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 6, display: 'block',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', borderRadius: 6,
  border: '1px solid #d1d5db', fontSize: 'var(--font-size-body)', boxSizing: 'border-box',
}
const selectStyle: React.CSSProperties = { ...inputStyle, background: '#fff' }

export function ReportChartConfig({
  chartType, onChartTypeChange,
  metric, onMetricChange,
  metricField, onMetricFieldChange,
  groupByNodeId, onGroupByNodeIdChange,
  groupByField, onGroupByFieldChange,
  limit, onLimitChange,
  sortDir, onSortDirChange,
  nodeDataMap, onSelectedFieldsChange,
  step3DateFields,
  previewLoading, previewData,
}: Props) {
  const isKpi        = chartType === 'kpi'
  const isTable      = chartType === 'table'
  const isTimeSeries = chartType === 'line' || chartType === 'area'
  const needsGroupBy = !isKpi && !isTable
  const needsLimit   = !isKpi && !isTable && !isTimeSeries

  const resultNodes = Object.entries(nodeDataMap).filter(([, nd]) => nd.isResult)

  return (
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
        Come vuoi vedere i dati?
      </h3>
      <p style={{ margin: '0 0 24px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        Configura la visualizzazione della sezione.
      </p>

      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ flex: '0 0 420px', display: 'flex', flexDirection: 'column', gap: 18 }}>

          <div>
            <label style={labelStyle}>Tipo di visualizzazione</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {CHART_TYPES.map(ct => (
                <div key={ct.value} onClick={() => onChartTypeChange(ct.value)} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                  borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s',
                  border:     chartType === ct.value ? '2px solid #0284c7' : '1px solid #e5e7eb',
                  background: chartType === ct.value ? 'var(--color-brand-light)' : '#fff',
                  color:      chartType === ct.value ? 'var(--color-brand)' : 'var(--color-slate)',
                }}>
                  {ct.icon}
                  <div>
                    <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600 }}>{ct.label}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: chartType === ct.value ? '#22d3ee' : 'var(--color-slate-light)', marginTop: 2 }}>{ct.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {needsGroupBy && resultNodes.length > 0 && (
            <div>
              <label style={labelStyle}>Raggruppa per</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <select value={groupByNodeId} onChange={e => onGroupByNodeIdChange(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                  <option value="">Nodo...</option>
                  {resultNodes.map(([nid, nd]) => (
                    <option key={nid} value={nid}>{nd.label}</option>
                  ))}
                </select>
                <select value={groupByField} onChange={e => onGroupByFieldChange(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                  <option value="">Campo...</option>
                  {groupByNodeId && nodeDataMap[groupByNodeId]
                    ? nodeDataMap[groupByNodeId].fields
                        .filter(f => !isTimeSeries || f.fieldType === 'date' || DATE_FIELD_NAMES.includes(f.name))
                        .map(f => (
                          <option key={f.name} value={f.name}>{f.label}</option>
                        ))
                    : null}
                </select>
              </div>
              {isTimeSeries && step3DateFields.length === 0 && (
                <div style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)', marginTop: 8 }}>
                  ⚠ Il grafico a linea richiede un campo data. Nessun campo data disponibile per questa entità. Scegli un altro tipo di grafico.
                </div>
              )}
            </div>
          )}

          {!isKpi && !isTable && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Metrica</label>
                <select value={metric} onChange={e => onMetricChange(e.target.value)} style={selectStyle}>
                  {METRIC_TYPES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              {metric !== 'count' && resultNodes.length > 0 && (
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Campo</label>
                  <select value={metricField} onChange={e => onMetricFieldChange(e.target.value)} style={selectStyle}>
                    <option value="">Seleziona...</option>
                    {resultNodes.flatMap(([, nd]) =>
                      nd.fields.filter(f => f.fieldType === 'number').map(f => (
                        <option key={f.name} value={f.name}>{f.label}</option>
                      ))
                    )}
                  </select>
                </div>
              )}
            </div>
          )}

          {needsLimit && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Mostra i primi N</label>
                <input type="number" value={limit} onChange={e => onLimitChange(Number(e.target.value))} style={inputStyle} min={1} max={100} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Ordine</label>
                <select value={sortDir} onChange={e => onSortDirChange(e.target.value)} style={selectStyle}>
                  <option value="DESC">Decrescente</option>
                  <option value="ASC">Crescente</option>
                </select>
              </div>
            </div>
          )}

          {isTable && resultNodes.length > 0 && (
            <div>
              <label style={labelStyle}>Colonne da mostrare (per nodo risultato)</label>
              {resultNodes.map(([nid, nd]) => (
                <div key={nid} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6 }}>{nd.label}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                    {nd.fields.map(f => (
                      <label key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={nd.selectedFields.includes(f.name)}
                          onChange={e => {
                            const updated = e.target.checked
                              ? [...nd.selectedFields, f.name]
                              : nd.selectedFields.filter(x => x !== f.name)
                            onSelectedFieldsChange(nid, updated)
                          }}
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={labelStyle}>Anteprima in tempo reale</label>
          <ReportPreview loading={previewLoading} data={previewData} />
        </div>
      </div>
    </div>
  )
}
