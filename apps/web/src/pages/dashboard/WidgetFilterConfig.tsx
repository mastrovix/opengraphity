import { Chip } from '@/components/ui/Chip'
import { Input, Select } from '@/components/ui/FormControls'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { FieldMeta, WidgetCatalogEntity } from './useWidgetConfig'
import {
  METRICS, TIME_RANGES, SIZE_OPTIONS, presetColors, widgetTint,
  FIELD_TYPE_LABEL_KEYS,
} from './useWidgetConfig'
import { palette } from '@/lib/tokens'
import { useItilTypeLabels } from '@/hooks/useItilTypeLabels'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useCILabels } from '@/hooks/useCILabels'

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
  /** Il catalogo del cliente (`widgetCatalog`). */
  entities:        WidgetCatalogEntity[]
  groupByFields:   FieldMeta[]
  filterFields:    FieldMeta[]
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
  entities, groupByFields, filterFields, needsGroupBy,
  fieldMetaMap, selectedFilterMeta,
}: WidgetFilterConfigProps) {
  // Le entità sono quelle del catalogo del cliente (ondata 5 di «Nulla
  // cablato»): i suoi tipi di ticket e di CI, anche quelli creati da lui.
  const { t } = useTranslation()
  const { labelOf: itilLabel } = useItilTypeLabels()
  // Il nome di un tipo CI: una funzione sola per tutta l'app (20 set 2026).
  const { typeLabel } = useCILabels()
  const entityLabel = (e: WidgetCatalogEntity) => {
    if (e.group === 'itsm') return itilLabel(e.entityType)
    return typeLabel(e.entityType)
  }
  const itsm = entities.filter((e) => e.group === 'itsm')
  const cmdb = entities.filter((e) => e.group !== 'itsm')
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
        <Select id={ids.entity} value={entityType} onChange={(e) => onEntityChange(e.target.value)}>
          {entities.length === 0 && <option value={entityType}>{entityType}</option>}
          {itsm.length > 0 && (
            <optgroup label={t('pages.dashboard.entityGroupItsm')}>
              {itsm.map((e) => <option key={e.entityType} value={e.entityType}>{entityLabel(e)}</option>)}
            </optgroup>
          )}
          {cmdb.length > 0 && (
            <optgroup label={t('pages.dashboard.entityGroupCmdb')}>
              {cmdb.map((e) => <option key={e.entityType} value={e.entityType}>{entityLabel(e)}</option>)}
            </optgroup>
          )}
        </Select>
      </div>

      {/* Metric */}
      <div>
        <label htmlFor={ids.metric} style={labelStyle}>{t('pages.dashboard.metricLabel')}</label>
        <Select id={ids.metric} value={metric} onChange={(e) => onMetricChange(e.target.value)}>
          {METRICS.map((m) => <option key={m.value} value={m.value}>{t(m.labelKey)}</option>)}
        </Select>
      </div>

      {/* Group by — only when needed */}
      {needsGroupBy && (
        <div>
          <label htmlFor={ids.groupBy} style={labelStyle}>{t('pages.dashboard.groupByField')}</label>
          <Select id={ids.groupBy} value={groupByField} onChange={(e) => onGroupByChange(e.target.value)}>
            <option value="">{t('pages.dashboard.selectField')}</option>
            {groupByFields.map((f) => <option key={f.name} value={f.name}>{fieldOptionLabel(f.name)}</option>)}
          </Select>
          {groupByFields.length === 0 && (
            <p role="note" style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
              {t(metric === 'count_by_field' ? 'pages.dashboard.noGroupableField' : 'pages.dashboard.noNumericField')}
            </p>
          )}
        </div>
      )}

      {/* Filter */}
      <div>
        <label htmlFor={ids.filter} style={labelStyle}>{t('pages.dashboard.filterOptional')}</label>
        <div className="og-pair">
          <Select id={ids.filter} value={filterField} onChange={(e) => onFilterFieldChange(e.target.value)}>
            <option value="">{t('pages.dashboard.noFilter')}</option>
            {filterFields.map((f) => <option key={f.name} value={f.name}>{fieldOptionLabel(f.name)}</option>)}
          </Select>
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
            <Chip pressed={timeRange === value} key={value} onClick={() => onTimeRangeChange(value)} accent={color} tint={widgetTint(color)}>
              {t(labelKey)}
            </Chip>
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
  const { labelOf } = useDomainVocabularies()
  const opacityStyle = { opacity: disabled ? 0.45 : 1 }
  const valueLabel = t('pages.dashboard.filterValue')

  // No field selected — disabled text input
  if (!meta || disabled) {
    return <Input aria-label={valueLabel} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('pages.dashboard.filterValuePlaceholder')} disabled style={{ ...opacityStyle }} />
  }

  // Enum — dropdown with values
  if (meta.fieldType === 'enum' && meta.enumValues.length > 0) {
    return (
      <Select aria-label={valueLabel} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('pages.dashboard.allValues')}</option>
        {meta.enumValues.map((v) => <option key={v} value={v}>{(meta.enumTypeName && labelOf(meta.enumTypeName, v)) || v}</option>)}
      </Select>
    )
  }

  // Boolean — toggle
  if (meta.fieldType === 'boolean') {
    return (
      <div role="group" aria-label={valueLabel} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {['true', 'false'].map((v) => (
          <Chip pressed={value === v} key={v} onClick={() => onChange(value === v ? '' : v)} accent={color} tint={widgetTint(color)}>
            {v === 'true' ? t('common.yes') : t('common.no')}
          </Chip>
        ))}
      </div>
    )
  }

  // Date — date picker
  if (meta.fieldType === 'date') {
    return <Input aria-label={valueLabel} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
  }

  // Number — numeric input
  if (meta.fieldType === 'number') {
    return <Input aria-label={valueLabel} type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('pages.dashboard.numberPlaceholder')} />
  }

  // Default (string) — text input
  return <Input aria-label={valueLabel} value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('pages.dashboard.filterValuePlaceholder')} />
}

// ── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-table)', fontWeight: 700,
  color: 'var(--color-slate)', marginBottom: 5,
  letterSpacing: 0.3, textTransform: 'uppercase',
}


