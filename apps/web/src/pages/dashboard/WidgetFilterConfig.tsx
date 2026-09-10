import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { FieldMeta } from './useWidgetConfig'
import {
  ENTITY_TYPES, METRICS, TIME_RANGES, SIZE_OPTIONS, presetColors, widgetTint,
  FIELD_TYPE_LABEL_KEYS,
} from './useWidgetConfig'
import { colors, palette } from '@/lib/tokens'

// ── Props ────────────────────────────────────────────────────────────────────

interface WidgetFilterConfigProps {
  /** false: nasconde entità/metrica/filtro/periodo (widget con sorgente dati fissa); restano dimensione e colore. */
  dataConfigurable?: boolean
  entityType:      string
  onEntityChange:  (v: string) => void
  metric:          string
  onMetricChange:  (v: string) => void
  groupByField:    string
  onGroupByChange: (v: string) => void
  filterField:     string
  onFilterFieldChange: (v: string) => void
  filterValue:     string
  onFilterValueChange: (v: string) => void
  timeRange:       string
  onTimeRangeChange: (v: string) => void
  size:            string
  onSizeChange:    (v: string) => void
  color:           string
  onColorChange:   (v: string) => void
  fields:          string[]
  needsGroupBy:    boolean
  fieldMetaMap:    Record<string, FieldMeta>
  selectedFilterMeta: FieldMeta | null
}

// ── Component ────────────────────────────────────────────────────────────────

export function WidgetFilterConfig({
  dataConfigurable = true,
  entityType, onEntityChange,
  metric, onMetricChange,
  groupByField, onGroupByChange,
  filterField, onFilterFieldChange,
  filterValue, onFilterValueChange,
  timeRange, onTimeRangeChange,
  size, onSizeChange,
  color, onColorChange,
  fields, needsGroupBy,
  fieldMetaMap, selectedFilterMeta,
}: WidgetFilterConfigProps) {
  const { t } = useTranslation()
  const id = useId()
  const ids = {
    entity:  id + '-entity',
    metric:  id + '-metric',
    groupBy: id + '-groupby',
    filter:  id + '-filter',
    period:  id + '-period',
    size:    id + '-size',
    color:   id + '-color',
  }

  /** "Etichetta (tipo)" per le option dei campi. */
  function fieldOptionLabel(f: string): string {
    const meta = fieldMetaMap[f]
    if (!meta) return f
    const typeKey = FIELD_TYPE_LABEL_KEYS[meta.fieldType]
    const typeLabel = typeKey ? t(typeKey) : meta.fieldType
    return `${meta.label ?? f} (${typeLabel})`
  }

  return (
    <>
      {dataConfigurable && <>
      {/* Entity */}
      <div>
        <label htmlFor={ids.entity} style={labelStyle}>{t('pages.dashboard.entityLabel')}</label>
        <select id={ids.entity} value={entityType} onChange={(e) => onEntityChange(e.target.value)} style={selectStyle}>
          {ENTITY_TYPES.map((e) => <option key={e.value} value={e.value}>{t(e.labelKey)}</option>)}
        </select>
      </div>

      {/* Metric */}
      <div>
        <label htmlFor={ids.metric} style={labelStyle}>{t('pages.dashboard.metricLabel')}</label>
        <select id={ids.metric} value={metric} onChange={(e) => onMetricChange(e.target.value)} style={selectStyle}>
          {METRICS.map((m) => <option key={m.value} value={m.value}>{t(m.labelKey)}</option>)}
        </select>
      </div>

      {/* Group by — only when needed */}
      {needsGroupBy && (
        <div>
          <label htmlFor={ids.groupBy} style={labelStyle}>{t('pages.dashboard.groupByField')}</label>
          <select id={ids.groupBy} value={groupByField} onChange={(e) => onGroupByChange(e.target.value)} style={selectStyle}>
            <option value="">{t('pages.dashboard.selectField')}</option>
            {fields.map((f) => <option key={f} value={f}>{fieldOptionLabel(f)}</option>)}
          </select>
        </div>
      )}

      {/* Filter */}
      <div>
        <label htmlFor={ids.filter} style={labelStyle}>{t('pages.dashboard.filterOptional')}</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <select id={ids.filter} value={filterField} onChange={(e) => onFilterFieldChange(e.target.value)} style={selectStyle}>
            <option value="">{t('pages.dashboard.noFilter')}</option>
            {fields.map((f) => <option key={f} value={f}>{fieldOptionLabel(f)}</option>)}
          </select>
          <FilterValueInput
            meta={selectedFilterMeta}
            value={filterValue}
            onChange={onFilterValueChange}
            disabled={!filterField}
            color={color}
          />
        </div>
      </div>

      {/* Period — 6 buttons */}
      <div>
        <div id={ids.period} style={labelStyle}>{t('pages.dashboard.period')}</div>
        <div role="group" aria-labelledby={ids.period} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TIME_RANGES.map(({ value, labelKey }) => (
            <button
              type="button"
              key={value}
              onClick={() => onTimeRangeChange(value)}
              aria-pressed={timeRange === value}
              style={{
                padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 500,
                border: timeRange === value ? `1.5px solid ${color}` : '1.5px solid var(--color-border)',
                background: timeRange === value ? widgetTint(color) : colors.white,
                color: timeRange === value ? color : 'var(--color-slate)',
              }}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
      </>}

      {/* Size — 3 buttons */}
      <div>
        <div id={ids.size} style={labelStyle}>{t('pages.dashboard.sizeLabel')}</div>
        <div role="group" aria-labelledby={ids.size} style={{ display: 'flex', gap: 8 }}>
          {SIZE_OPTIONS.map(({ value, labelKey, subKey }) => (
            <button
              type="button"
              key={value}
              onClick={() => onSizeChange(value)}
              aria-pressed={size === value}
              style={{
                flex: 1, padding: '8px 6px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                border: size === value ? `2px solid ${color}` : '1.5px solid var(--color-border)',
                background: size === value ? widgetTint(color) : palette.neutral.surface1,
                color: size === value ? color : 'var(--color-slate)',
              }}
            >
              <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600 }}>{t(labelKey)}</div>
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', marginTop: 1 }}>{t(subKey)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Color — 6 circles + custom */}
      <div>
        <div id={ids.color} style={labelStyle}>{t('pages.dashboard.colorLabel')}</div>
        <div role="group" aria-labelledby={ids.color} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {presetColors().map(({ value: c, nameKey }) => (
            <button
              type="button"
              key={c}
              onClick={() => onColorChange(c)}
              aria-pressed={color === c}
              aria-label={t(nameKey)}
              title={t(nameKey)}
              style={{
                width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                border: color === c ? '3px solid var(--color-slate-dark)' : '2.5px solid transparent',
                outline: color === c ? `2.5px solid ${c}` : 'none',
                outlineOffset: 1,
                transition: 'transform 0.1s',
                transform: color === c ? 'scale(1.2)' : 'scale(1)',
              }}
            />
          ))}
          <input
            type="color"
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
            title={t('pages.dashboard.customColor')}
            aria-label={t('pages.dashboard.customColor')}
            style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid var(--color-border-strong)', cursor: 'pointer', padding: 2 }}
          />
        </div>
      </div>
    </>
  )
}

// ── FilterValueInput (local sub-component) ───────────────────────────────────

function FilterValueInput({ meta, value, onChange, disabled, color }: {
  meta: FieldMeta | null; value: string; onChange: (v: string) => void; disabled: boolean; color: string
}) {
  const { t } = useTranslation()
  const opacityStyle = { opacity: disabled ? 0.45 : 1 }
  const valueLabel = t('pages.dashboard.filterValue')

  // No field selected — disabled text input
  if (!meta || disabled) {
    return <input aria-label={valueLabel} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('pages.dashboard.filterValuePlaceholder')} disabled style={{ ...inputStyle, ...opacityStyle }} />
  }

  // Enum — dropdown with values
  if (meta.fieldType === 'enum' && meta.enumValues.length > 0) {
    return (
      <select aria-label={valueLabel} value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        <option value="">{t('pages.dashboard.allValues')}</option>
        {meta.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  // Boolean — toggle
  if (meta.fieldType === 'boolean') {
    return (
      <div role="group" aria-label={valueLabel} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {['true', 'false'].map((v) => (
          <button
            type="button"
            key={v}
            onClick={() => onChange(value === v ? '' : v)}
            aria-pressed={value === v}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 7, cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600, textAlign: 'center',
              border: value === v ? `1.5px solid ${color}` : '1.5px solid var(--color-border)',
              background: value === v ? widgetTint(color) : colors.white,
              color: value === v ? color : 'var(--color-slate)',
            }}
          >
            {v === 'true' ? t('common.yes') : t('common.no')}
          </button>
        ))}
      </div>
    )
  }

  // Date — date picker
  if (meta.fieldType === 'date') {
    return <input aria-label={valueLabel} type="date" value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
  }

  // Number — numeric input
  if (meta.fieldType === 'number') {
    return <input aria-label={valueLabel} type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('pages.dashboard.numberPlaceholder')} style={inputStyle} />
  }

  // Default (string) — text input
  return <input aria-label={valueLabel} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('pages.dashboard.filterValuePlaceholder')} style={inputStyle} />
}

// ── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-table)', fontWeight: 700,
  color: 'var(--color-slate)', marginBottom: 5,
  letterSpacing: 0.3, textTransform: 'uppercase',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7,
  border: '1.5px solid var(--color-border)', fontSize: 'var(--font-size-body)',
  boxSizing: 'border-box', color: 'var(--color-slate-dark)',
  outline: 'none',
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7,
  border: '1.5px solid var(--color-border)', fontSize: 'var(--font-size-body)',
  background: colors.white, color: 'var(--color-slate-dark)',
}
