import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Hash, PieChart, CircleDot, BarChart2, BarChart, LineChart, TrendingUp, ListOrdered,
  Table as TableIcon,
} from 'lucide-react'
import { ReportPreview } from './ReportPreview'
import type { SectionResult } from './ReportPreview'
import type { NavigableField } from './ReportFlowNodes'
import { colors, palette } from '@/lib/tokens'

/*
  CHIAVI, non etichette: erano frasi italiane in una costante, e a schermo
  restavano italiane in qualunque lingua. Chi le mostra le risolve con `t()`;
  chi le usa per COMPORRE un titolo (il suggerimento della sezione) pure.
*/
export const CHART_TYPES = [
  { value: 'kpi',            labelKey: 'reportChart.type.kpi',           descKey: 'reportChart.desc.kpi',           icon: <Hash size={18} /> },
  { value: 'pie',            labelKey: 'reportChart.type.pie',           descKey: 'reportChart.desc.pie',           icon: <PieChart size={18} /> },
  { value: 'donut',          labelKey: 'reportChart.type.donut',         descKey: 'reportChart.desc.donut',         icon: <CircleDot size={18} /> },
  { value: 'bar',            labelKey: 'reportChart.type.bar',           descKey: 'reportChart.desc.bar',           icon: <BarChart2 size={18} /> },
  { value: 'bar_horizontal', labelKey: 'reportChart.type.barHorizontal', descKey: 'reportChart.desc.barHorizontal', icon: <BarChart size={18} /> },
  { value: 'line',           labelKey: 'reportChart.type.line',          descKey: 'reportChart.desc.line',          icon: <LineChart size={18} /> },
  { value: 'area',           labelKey: 'reportChart.type.area',          descKey: 'reportChart.desc.area',          icon: <TrendingUp size={18} /> },
  { value: 'table',          labelKey: 'reportChart.type.table',         descKey: 'reportChart.desc.table',         icon: <TableIcon size={18} /> },
  /* `top_n` esisteva nell'API (e nei suoi test) e NON si poteva scegliere:
     chi apriva un report che lo usava leggeva «top_n» come nome del grafico. */
  { value: 'top_n',          labelKey: 'reportChart.type.topN',          descKey: 'reportChart.desc.topN',          icon: <ListOrdered size={18} /> },
]

export const METRIC_TYPES = [
  { value: 'count', labelKey: 'reportChart.metric.count' },
  { value: 'avg',   labelKey: 'reportChart.metric.avg' },
  { value: 'sum',   labelKey: 'reportChart.metric.sum' },
  { value: 'min',   labelKey: 'reportChart.metric.min' },
  { value: 'max',   labelKey: 'reportChart.metric.max' },
]

/**
 * Il PERIODO di una serie temporale (19 set 2026). Mancava: una serie
 * raggruppava per GIORNO e basta, quindi «gli ultimi 6 mesi» erano 180 punti
 * appiccicati. Chi chiede sei mesi vuole i mesi.
 */
export const GRANULARITIES = [
  { value: 'day',   labelKey: 'reportChart.granularity.day' },
  { value: 'week',  labelKey: 'reportChart.granularity.week' },
  { value: 'month', labelKey: 'reportChart.granularity.month' },
  { value: 'year',  labelKey: 'reportChart.granularity.year' },
]

export const DATE_FIELD_NAMES = ['created_at', 'updated_at', 'resolved_at', 'expires_at', 'scheduled_start', 'scheduled_end', 'implemented_at']

interface NodeDataEntry {
  label:          string
  fields:         NavigableField[]
  selectedFields: string[]
  isResult:       boolean
  /** La RADICE: è il nodo su cui si calcola la metrica (vedi sotto). */
  isRoot:         boolean
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
  groupByGranularity:     string
  onGroupByGranularityChange: (v: string) => void
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
  border: `1px solid ${palette.neutral.borderStrong}`, fontSize: 'var(--font-size-body)', boxSizing: 'border-box',
}
const selectStyle: React.CSSProperties = { ...inputStyle, background: colors.white }

export function ReportChartConfig({
  chartType, onChartTypeChange,
  metric, onMetricChange,
  metricField, onMetricFieldChange,
  groupByNodeId, onGroupByNodeIdChange,
  groupByField, onGroupByFieldChange,
  groupByGranularity, onGroupByGranularityChange,
  limit, onLimitChange,
  sortDir, onSortDirChange,
  nodeDataMap, onSelectedFieldsChange,
  step3DateFields,
  previewLoading, previewData,
}: Props) {
  const { t } = useTranslation()
  const uid = useId()
  const ids = { granularity: `${uid}-granularity`, metric: `${uid}-metric`, metricField: `${uid}-metric-field`, limit: `${uid}-limit`, sortDir: `${uid}-sort-dir` }
  const isKpi        = chartType === 'kpi'
  const isTable      = chartType === 'table'
  const isTimeSeries = chartType === 'line' || chartType === 'area'
  const needsGroupBy = !isKpi && !isTable
  const needsLimit   = !isKpi && !isTable && !isTimeSeries

  const resultNodes = Object.entries(nodeDataMap).filter(([, nd]) => nd.isResult)
  /** I campi su cui una metrica si può calcolare: numerici, e della RADICE. */
  /**
   * Il campo su cui si raggruppa è una DATA? Lo dice il metamodello
   * (`fieldType`), con i nomi noti come rete per i campi che il metamodello
   * non tipizza.
   */
  const campoDelGruppo = (nodeDataMap[groupByNodeId]?.fields ?? []).find((f) => f.name === groupByField)
  const raggruppaPerData = groupByField !== '' && (
    campoDelGruppo?.fieldType === 'date' || campoDelGruppo?.fieldType === 'datetime'
    || DATE_FIELD_NAMES.includes(groupByField)
  )

  const campiNumericiDellaRadice = (Object.values(nodeDataMap).find((nd) => nd.isRoot)?.fields ?? [])
    .filter((f) => f.fieldType === 'number')
  const tableColumnCount = resultNodes.reduce((acc, [, nd]) => acc + nd.selectedFields.length, 0)

  return (
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
        {t('reportChart.howToSee')}
      </h3>
      <p style={{ margin: '0 0 24px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('reportChart.configure')}
      </p>

      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ flex: '0 0 420px', display: 'flex', flexDirection: 'column', gap: 18 }}>

          <div>
            <div style={labelStyle}>{t('reportChart.chartType')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {CHART_TYPES.map(ct => (
                <button key={ct.value} type="button" aria-pressed={chartType === ct.value} onClick={() => onChartTypeChange(ct.value)} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                  borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s',
                  font: 'inherit', textAlign: 'left', width: '100%',
                  border:     chartType === ct.value ? `2px solid ${colors.brand}` : `1px solid ${colors.border}`,
                  background: chartType === ct.value ? 'var(--color-brand-light)' : colors.white,
                  color:      chartType === ct.value ? 'var(--color-brand)' : 'var(--color-slate)',
                }}>
                  {ct.icon}
                  <div>
                    <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600 }}>{t(ct.labelKey)}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: chartType === ct.value ? palette.teal.light : 'var(--color-slate-light)', marginTop: 2 }}>{t(ct.descKey)}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {needsGroupBy && resultNodes.length > 0 && (
            <div>
              <div style={labelStyle}>{t('reportChart.groupBy')}</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <select value={groupByNodeId} onChange={e => onGroupByNodeIdChange(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                  <option value="">{t('reportChart.nodePlaceholder')}</option>
                  {resultNodes.map(([nid, nd]) => (
                    <option key={nid} value={nid}>{nd.label}</option>
                  ))}
                </select>
                <select value={groupByField} onChange={e => onGroupByFieldChange(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                  <option value="">{t('reportChart.fieldOption')}</option>
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
                  {t('reportChart.needsDateField')}
                </div>
              )}
            </div>
          )}

          {!isKpi && !isTable && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label htmlFor={ids.metric} style={labelStyle}>{t('reportChart.metricLabel')}</label>
                <select id={ids.metric} value={metric} onChange={e => onMetricChange(e.target.value)} style={selectStyle}>
                  {METRIC_TYPES.map(m => <option key={m.value} value={m.value}>{t(m.labelKey)}</option>)}
                </select>
              </div>
              {/*
                IL CAMPO DELLA METRICA VIENE DALLA RADICE (19 set 2026).

                Prima si pescava da tutti i nodi «risultato», ma l'aggregazione
                si calcola sulla radice: un campo di un altro nodo darebbe una
                proprietà che la radice non ha, cioè `null` — una media
                silenziosamente sbagliata. E la metrica ora si calcola davvero
                (prima era sempre un conteggio), quindi offrire il campo
                sbagliato costerebbe un numero falso invece di niente.
              */}
              {metric !== 'count' && (
                <div style={{ flex: 1 }}>
                  <label htmlFor={ids.metricField} style={labelStyle}>{t('reportChart.field')}</label>
                  <select id={ids.metricField} value={metricField} onChange={e => onMetricFieldChange(e.target.value)} style={selectStyle}>
                    <option value="">{t('common.select')}</option>
                    {campiNumericiDellaRadice.map((f) => (
                      <option key={f.name} value={f.name}>{f.label}</option>
                    ))}
                  </select>
                  {campiNumericiDellaRadice.length === 0 && (
                    <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                      {t('reportChart.noNumericField')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/*
            IL PERIODO compare per QUALUNQUE grafico raggruppato per una DATA
            (19 set 2026).
            Stava solo sulle serie, e intanto il costruttore offriva i campi
            data anche agli istogrammi: raggruppare le barre per «Creato il»
            dava una barra per timestamp — dodici barre alte 1 con sotto
            «2026-07-15T11:05:33.963Z».

            `needsGroupBy` e non il tipo di grafico: dove il raggruppamento
            non c'è (numero totale, tabella) il periodo non vuol dire niente,
            e il campo scelto prima resterebbe nello stato a far comparire una
            tendina che non governa niente.
          */}
          {needsGroupBy && raggruppaPerData && (
            <div>
              <label htmlFor={ids.granularity} style={labelStyle}>{t('reportChart.granularityLabel')}</label>
              <select id={ids.granularity} value={groupByGranularity || 'day'}
                onChange={e => onGroupByGranularityChange(e.target.value)} style={selectStyle}>
                {GRANULARITIES.map(g => <option key={g.value} value={g.value}>{t(g.labelKey)}</option>)}
              </select>
            </div>
          )}

          {needsLimit && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label htmlFor={ids.limit} style={labelStyle}>{t('reportChart.topN')}</label>
                <input id={ids.limit} type="number" value={limit} onChange={e => onLimitChange(Number(e.target.value))} style={inputStyle} min={1} max={100} />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor={ids.sortDir} style={labelStyle}>{t('common.order')}</label>
                <select id={ids.sortDir} value={sortDir} onChange={e => onSortDirChange(e.target.value)} style={selectStyle}>
                  <option value="DESC">{t('reportChart.descending')}</option>
                  <option value="ASC">{t('reportChart.ascending')}</option>
                </select>
              </div>
            </div>
          )}

          {isTable && resultNodes.length > 0 && (
            <div>
              <div style={labelStyle}>{t('reportChart.columnsToShow')}</div>
              {tableColumnCount === 0 && (
                <div style={{ color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)', marginBottom: 8 }}>
                  {t('reportChart.needsColumn')}
                </div>
              )}
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
          <div style={labelStyle}>{t('reportChart.livePreview')}</div>
          <ReportPreview loading={previewLoading} data={previewData} granularita={raggruppaPerData ? groupByGranularity : null} />
        </div>
      </div>
    </div>
  )
}
