import type { FieldMeta } from './useWidgetConfig'
import {
  ENTITY_TYPES, METRICS, TIME_RANGES, SIZE_OPTIONS, PRESET_COLORS,
  FIELD_TYPE_LABELS,
} from './useWidgetConfig'

// ── Props ────────────────────────────────────────────────────────────────────

interface WidgetFilterConfigProps {
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
  return (
    <>
      {/* Entity */}
      <div>
        <label style={labelStyle}>Entit&agrave;</label>
        <select value={entityType} onChange={(e) => onEntityChange(e.target.value)} style={selectStyle}>
          {ENTITY_TYPES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
      </div>

      {/* Metric */}
      <div>
        <label style={labelStyle}>Metrica</label>
        <select value={metric} onChange={(e) => onMetricChange(e.target.value)} style={selectStyle}>
          {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      {/* Group by — only when needed */}
      {needsGroupBy && (
        <div>
          <label style={labelStyle}>Campo raggruppamento</label>
          <select value={groupByField} onChange={(e) => onGroupByChange(e.target.value)} style={selectStyle}>
            <option value="">-- Seleziona campo --</option>
            {fields.map((f) => {
              const meta = fieldMetaMap[f]
              const typeLabel = meta ? FIELD_TYPE_LABELS[meta.fieldType] ?? meta.fieldType : ''
              return <option key={f} value={f}>{meta?.label ?? f}{typeLabel ? ` (${typeLabel})` : ''}</option>
            })}
          </select>
        </div>
      )}

      {/* Filter */}
      <div>
        <label style={labelStyle}>Filtro (opzionale)</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <select value={filterField} onChange={(e) => onFilterFieldChange(e.target.value)} style={selectStyle}>
            <option value="">Nessun filtro</option>
            {fields.map((f) => {
              const meta = fieldMetaMap[f]
              const typeLabel = meta ? FIELD_TYPE_LABELS[meta.fieldType] ?? meta.fieldType : ''
              return <option key={f} value={f}>{meta?.label ?? f}{typeLabel ? ` (${typeLabel})` : ''}</option>
            })}
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
        <label style={labelStyle}>Periodo</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TIME_RANGES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => onTimeRangeChange(value)}
              style={{
                padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500,
                border: timeRange === value ? `1.5px solid ${color}` : '1.5px solid #e5e7eb',
                background: timeRange === value ? `${color}14` : '#fff',
                color: timeRange === value ? color : 'var(--color-slate)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Size — 3 buttons */}
      <div>
        <label style={labelStyle}>Dimensione</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {SIZE_OPTIONS.map(({ value, label, sub }) => (
            <button
              key={value}
              onClick={() => onSizeChange(value)}
              style={{
                flex: 1, padding: '8px 6px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                border: size === value ? `2px solid ${color}` : '1.5px solid #e5e7eb',
                background: size === value ? `${color}14` : '#fafafa',
                color: size === value ? color : 'var(--color-slate)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 10, color: 'var(--color-slate-light)', marginTop: 1 }}>{sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Color — 6 circles + custom */}
      <div>
        <label style={labelStyle}>Colore</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => onColorChange(c)}
              style={{
                width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                border: color === c ? '3px solid #1e293b' : '2.5px solid transparent',
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
            title="Colore personalizzato"
            style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid #d1d5db', cursor: 'pointer', padding: 2 }}
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
  const opacityStyle = { opacity: disabled ? 0.45 : 1 }

  // No field selected — disabled text input
  if (!meta || disabled) {
    return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Es. new" disabled style={{ ...inputStyle, ...opacityStyle }} />
  }

  // Enum — dropdown with values
  if (meta.fieldType === 'enum' && meta.enumValues.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        <option value="">-- Tutti --</option>
        {meta.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  // Boolean — toggle
  if (meta.fieldType === 'boolean') {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {['true', 'false'].map((v) => (
          <button
            key={v}
            onClick={() => onChange(value === v ? '' : v)}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600, textAlign: 'center',
              border: value === v ? `1.5px solid ${color}` : '1.5px solid #e5e7eb',
              background: value === v ? `${color}14` : '#fff',
              color: value === v ? color : 'var(--color-slate)',
            }}
          >
            {v === 'true' ? 'S\u00ec' : 'No'}
          </button>
        ))}
      </div>
    )
  }

  // Date — date picker
  if (meta.fieldType === 'date') {
    return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
  }

  // Number — numeric input
  if (meta.fieldType === 'number') {
    return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Es. 5" style={inputStyle} />
  }

  // Default (string) — text input
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Es. new" style={inputStyle} />
}

// ── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700,
  color: 'var(--color-slate)', marginBottom: 5,
  letterSpacing: 0.3, textTransform: 'uppercase',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7,
  border: '1.5px solid #e2e8f0', fontSize: 13,
  boxSizing: 'border-box', color: 'var(--color-slate-dark)',
  outline: 'none',
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7,
  border: '1.5px solid #e2e8f0', fontSize: 13,
  background: '#fff', color: 'var(--color-slate-dark)',
}
