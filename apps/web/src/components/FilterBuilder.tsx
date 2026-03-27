import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X, ChevronDown, ChevronRight } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

export type FilterOperator =
  | 'contains' | 'starts_with' | 'ends_with' | 'equals' | 'not_equals'
  | 'is_empty' | 'is_not_empty'
  | 'after' | 'before' | 'between' | 'today' | 'last_7_days' | 'last_30_days'
  | 'in' | 'not_in'

export interface FilterRule {
  id:        string
  field:     string
  operator:  FilterOperator
  value:     string | string[] | null
  value2?:   string
  logic:     'AND' | 'OR'   // connettore con la regola SUCCESSIVA
}

export interface FilterGroup {
  rules: FilterRule[]
}

export interface FieldConfig {
  key:         string
  label:       string
  type:        'text' | 'date' | 'enum'
  enumValues?: string[]
}

// ── Operator definitions ──────────────────────────────────────────────────────

const OPERATORS_BY_TYPE: Record<string, { value: FilterOperator; labelKey: string }[]> = {
  text: [
    { value: 'contains',     labelKey: 'filter.contains'     },
    { value: 'starts_with',  labelKey: 'filter.startsWith'   },
    { value: 'ends_with',    labelKey: 'filter.endsWith'     },
    { value: 'equals',       labelKey: 'filter.equals'       },
    { value: 'not_equals',   labelKey: 'filter.notEquals'    },
    { value: 'is_empty',     labelKey: 'filter.isEmpty'      },
    { value: 'is_not_empty', labelKey: 'filter.isNotEmpty'   },
  ],
  date: [
    { value: 'after',        labelKey: 'filter.after'        },
    { value: 'before',       labelKey: 'filter.before'       },
    { value: 'between',      labelKey: 'filter.between'      },
    { value: 'today',        labelKey: 'filter.today'        },
    { value: 'last_7_days',  labelKey: 'filter.last7Days'    },
    { value: 'last_30_days', labelKey: 'filter.last30Days'   },
  ],
  enum: [
    { value: 'equals',       labelKey: 'filter.equals'       },
    { value: 'not_equals',   labelKey: 'filter.notEquals'    },
    { value: 'in',           labelKey: 'filter.isOneOf'      },
    { value: 'not_in',       labelKey: 'filter.isNotOneOf'   },
  ],
}

const NO_VALUE_OPS = new Set<FilterOperator>([
  'is_empty', 'is_not_empty', 'today', 'last_7_days', 'last_30_days',
])

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultOperator(type: FieldConfig['type']): FilterOperator {
  if (type === 'date') return 'after'
  if (type === 'enum') return 'equals'
  return 'contains'
}

function makeRule(): FilterRule {
  return {
    id:       crypto.randomUUID(),
    field:    '',
    operator: 'contains',
    value:    null,
    logic:    'AND',
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SEL: React.CSSProperties = {
  height:          28,
  padding:         '0 6px',
  borderRadius:    4,
  border:          '1px solid #e2e8f0',
  fontSize:        12,
  color:           'var(--color-slate-dark)',
  backgroundColor: '#fff',
  outline:         'none',
  cursor:          'pointer',
}

const INP: React.CSSProperties = {
  height:          28,
  padding:         '0 8px',
  borderRadius:    4,
  border:          '1px solid #e2e8f0',
  fontSize:        12,
  color:           'var(--color-slate-dark)',
  backgroundColor: '#fff',
  outline:         'none',
}

// ── ValueInput ────────────────────────────────────────────────────────────────

function ValueInput({
  rule,
  fieldCfg,
  onChange,
}: {
  rule:     FilterRule
  fieldCfg: FieldConfig | undefined
  onChange: (partial: Partial<FilterRule>) => void
}) {
  if (!fieldCfg || NO_VALUE_OPS.has(rule.operator)) return null

  const type = fieldCfg.type

  if (rule.operator === 'between') {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="date"
          value={typeof rule.value === 'string' ? rule.value : ''}
          onChange={(e) => onChange({ value: e.target.value })}
          style={INP}
        />
        <span style={{ fontSize: 11, color: 'var(--color-slate-light)' }}>e</span>
        <input
          type="date"
          value={rule.value2 ?? ''}
          onChange={(e) => onChange({ value2: e.target.value })}
          style={INP}
        />
      </div>
    )
  }

  if ((rule.operator === 'in' || rule.operator === 'not_in') && type === 'enum') {
    const selected = Array.isArray(rule.value) ? rule.value : []
    const toggle = (v: string) => {
      const next = selected.includes(v)
        ? selected.filter((x) => x !== v)
        : [...selected, v]
      onChange({ value: next })
    }
    return (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {(fieldCfg.enumValues ?? []).map((v) => (
          <label
            key={v}
            style={{
              display:         'flex',
              alignItems:      'center',
              gap:             4,
              fontSize:        11,
              padding:         '2px 8px',
              borderRadius:    4,
              border:          `1px solid ${selected.includes(v) ? '#0284c7' : '#e2e8f0'}`,
              backgroundColor: selected.includes(v) ? 'rgba(2,132,199,0.1)' : '#fff',
              color:           selected.includes(v) ? 'var(--color-brand)' : 'var(--color-slate)',
              cursor:          'pointer',
              userSelect:      'none',
            }}
          >
            <input
              type="checkbox"
              checked={selected.includes(v)}
              onChange={() => toggle(v)}
              style={{ display: 'none' }}
            />
            {v}
          </label>
        ))}
      </div>
    )
  }

  if (type === 'enum') {
    return (
      <select
        value={typeof rule.value === 'string' ? rule.value : ''}
        onChange={(e) => onChange({ value: e.target.value })}
        style={{ ...SEL, minWidth: 120 }}
      >
        <option value="">Seleziona…</option>
        {(fieldCfg.enumValues ?? []).map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    )
  }

  if (type === 'date') {
    return (
      <input
        type="date"
        value={typeof rule.value === 'string' ? rule.value : ''}
        onChange={(e) => onChange({ value: e.target.value })}
        style={{ ...INP, minWidth: 140 }}
      />
    )
  }

  return (
    <input
      type="text"
      value={typeof rule.value === 'string' ? rule.value : ''}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder="Valore…"
      style={{ ...INP, minWidth: 160 }}
    />
  )
}

// ── LogicConnector — toggle AND/OR tra due righe ──────────────────────────────

function LogicConnector({
  value,
  onChange,
}: {
  value:    'AND' | 'OR'
  onChange: (v: 'AND' | 'OR') => void
}) {
  const { t } = useTranslation()
  const LOGIC_LABELS: Record<'AND' | 'OR', string> = {
    AND: t('filter.andConnector'),
    OR:  t('filter.orConnector'),
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px' }}>
      <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid #e2e8f0' }}>
        {(['AND', 'OR'] as const).map((l) => (
          <button
            key={l}
            onClick={() => onChange(l)}
            style={{
              padding:         '2px 10px',
              fontSize:        10,
              fontWeight:      700,
              letterSpacing:   '0.04em',
              border:          'none',
              cursor:          'pointer',
              backgroundColor: value === l ? 'var(--color-brand)' : '#fff',
              color:           value === l ? '#fff' : 'var(--color-slate-light)',
              transition:      'background 100ms',
            }}
          >
            {LOGIC_LABELS[l]}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface FilterBuilderProps {
  fields:  FieldConfig[]
  onApply: (group: FilterGroup | null) => void
}

export function FilterBuilder({ fields, onApply }: FilterBuilderProps) {
  const { t } = useTranslation()
  const [open,  setOpen]  = useState(false)
  const [rules, setRules] = useState<FilterRule[]>([])

  const updateRule = (id: string, partial: Partial<FilterRule>) => {
    setRules((rs) => rs.map((r) => {
      if (r.id !== id) return r
      const updated = { ...r, ...partial }
      if ('field' in partial && partial.field !== r.field) {
        const newField = fields.find((f) => f.key === partial.field)
        updated.operator = newField ? defaultOperator(newField.type) : 'contains'
        updated.value    = null
        updated.value2   = undefined
      }
      if (partial.operator && partial.operator !== r.operator) {
        updated.value  = null
        updated.value2 = undefined
      }
      return updated
    }))
  }

  const addRule = () => {
    setRules((rs) => [...rs, makeRule()])
  }

  const removeRule = (id: string) => setRules((rs) => rs.filter((r) => r.id !== id))

  const handleApply = () => {
    const active = rules.filter((r) => {
      if (!r.field) return false
      if (NO_VALUE_OPS.has(r.operator)) return true
      if (r.operator === 'between') return r.value != null && r.value2 != null
      if (r.operator === 'in' || r.operator === 'not_in')
        return Array.isArray(r.value) && r.value.length > 0
      return r.value !== null && r.value !== ''
    })
    onApply(active.length > 0 ? { rules: active } : null)
  }

  const handleReset = () => {
    setRules([])
    onApply(null)
  }

  const activeCount = rules.length

  return (
    <div className="card-border" style={{ marginBottom: 16, padding: '10px 14px' }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 10 : 0 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display:         'flex',
            alignItems:      'center',
            gap:             6,
            padding:         '5px 10px',
            borderRadius:    6,
            border:          '1px solid #e2e8f0',
            backgroundColor: activeCount > 0 ? 'rgba(2,132,199,0.08)' : '#fff',
            color:           activeCount > 0 ? 'var(--color-brand)' : 'var(--color-slate)',
            fontSize:        12,
            cursor:          'pointer',
            fontWeight:      activeCount > 0 ? 600 : 400,
          }}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t('filter.advancedFilters')}
          {activeCount > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, lineHeight: 1,
              padding: '1px 5px', borderRadius: 8,
              background: 'var(--color-brand)', color: '#fff',
            }}>
              {activeCount}
            </span>
          )}
        </button>

        {open && (
          <>
            <button
              onClick={addRule}
              style={{
                display:         'flex',
                alignItems:      'center',
                gap:             4,
                padding:         '4px 10px',
                borderRadius:    6,
                border:          '1px solid #e2e8f0',
                backgroundColor: '#fff',
                color:           'var(--color-slate)',
                fontSize:        12,
                cursor:          'pointer',
              }}
            >
              <Plus size={13} />
              {t('filter.addFilter')}
            </button>

            <div style={{ flex: 1 }} />

            <button
              onClick={handleApply}
              style={{
                padding:         '4px 14px',
                borderRadius:    6,
                border:          '1px solid #0284c7',
                backgroundColor: 'var(--color-brand)',
                color:           '#fff',
                fontSize:        12,
                fontWeight:      600,
                cursor:          'pointer',
              }}
            >
              {t('common.apply')}
            </button>

            <button
              onClick={handleReset}
              style={{
                padding:         '4px 14px',
                borderRadius:    6,
                border:          '1px solid #e2e8f0',
                backgroundColor: '#fff',
                color:           'var(--color-slate)',
                fontSize:        12,
                cursor:          'pointer',
              }}
            >
              {t('common.reset')}
            </button>
          </>
        )}
      </div>

      {/* Rules panel */}
      {open && (
        <div>
          {rules.length === 0 ? (
            <div style={{
              padding:   '8px 0',
              fontSize:  12,
              color:     'var(--color-slate-light)',
            }}>
              {t('filter.addFilter')}
            </div>
          ) : (
            rules.map((rule, idx) => {
              const fieldCfg  = fields.find((f) => f.key === rule.field)
              const fieldType = fieldCfg?.type ?? 'text'
              const operators = OPERATORS_BY_TYPE[fieldType] ?? OPERATORS_BY_TYPE.text

              return (
                <div key={rule.id}>
                  {/* Rule row */}
                  <div style={{
                    display:      'flex',
                    alignItems:   'center',
                    gap:          8,
                    padding:      '8px 10px',
                    border:       '1px solid #e2e8f0',
                    borderRadius: 4,
                    backgroundColor: '#fff',
                  }}>
                    {/* Field selector */}
                    <select
                      value={rule.field}
                      onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                      style={{ ...SEL, minWidth: 140, color: rule.field ? 'var(--color-slate-dark)' : 'var(--color-slate-light)' }}
                    >
                      <option value="">{t('filter.selectField')}</option>
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>

                    {/* Operator selector — visibile solo dopo aver scelto il campo */}
                    {rule.field && (
                      <select
                        value={rule.operator}
                        onChange={(e) => updateRule(rule.id, { operator: e.target.value as FilterOperator })}
                        style={{ ...SEL, minWidth: 140 }}
                      >
                        {operators.map((op) => (
                          <option key={op.value} value={op.value}>{t(op.labelKey)}</option>
                        ))}
                      </select>
                    )}

                    {/* Value input — visibile solo dopo aver scelto campo e operatore */}
                    {rule.field && (
                      <div style={{ flex: 1 }}>
                        <ValueInput
                          rule={rule}
                          fieldCfg={fieldCfg}
                          onChange={(p) => updateRule(rule.id, p)}
                        />
                      </div>
                    )}

                    {/* Remove */}
                    <button
                      onClick={() => removeRule(rule.id)}
                      style={{
                        display:         'flex',
                        alignItems:      'center',
                        justifyContent:  'center',
                        width:           24,
                        height:          24,
                        borderRadius:    4,
                        border:          '1px solid #fecaca',
                        backgroundColor: '#fff',
                        color:           '#ef4444',
                        cursor:          'pointer',
                        flexShrink:      0,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#fef2f2' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = '#fff' }}
                    >
                      <X size={13} />
                    </button>
                  </div>

                  {/* AND/OR connector — shown between every pair of rules */}
                  {idx < rules.length - 1 && (
                    <LogicConnector
                      value={rule.logic}
                      onChange={(l) => updateRule(rule.id, { logic: l })}
                    />
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
