import { Pill } from '@/components/ui/Pill'
import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X, ChevronDown, ChevronRight } from 'lucide-react'
import { alpha, colors, palette } from '@/lib/tokens'
import { srOnlyStyle } from '@/lib/a11y'

// ── Types ─────────────────────────────────────────────────────────────────────

export type FilterOperator =
  | 'contains' | 'starts_with' | 'ends_with' | 'equals' | 'not_equals'
  | 'is_empty' | 'is_not_empty'
  | 'after' | 'before' | 'between' | 'today' | 'last_7_days' | 'last_30_days'
  | 'in' | 'not_in'
  // Operatori di LISTA, per i campi a selezione multipla (moduli del catalogo,
  // ondata 4): il valore sul nodo è una lista, e «uguale a» non trova niente.
  | 'has_any' | 'has_all' | 'has_none' | 'list_is_empty' | 'list_is_not_empty'

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
  key:      string
  label:    string
  type:     'text' | 'date' | 'enum' | 'multi_enum'
  /**
   * Gli operatori ammessi, quando sono MENO di quelli del tipo (ondata 7): un
   * filtro sulle righe di una tabella passa da una relazione, e una relazione
   * sa fare uguale, contiene e vuoto. Offrire gli altri vorrebbe dire offrire
   * un filtro che il server rifiuta — il tipo di trappola che questo progetto
   * ha già pagato con i vocabolari scritti a mano.
   */
  operators?: readonly FilterOperator[]
  options?: { value: string; label: string }[]  // for enum type
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
  // Selezione multipla: nessun «uguale a», che su una lista sarebbe una
  // domanda a cui il database risponde sempre di no.
  multi_enum: [
    { value: 'has_any',           labelKey: 'filter.hasAny'      },
    { value: 'has_all',           labelKey: 'filter.hasAll'      },
    { value: 'has_none',          labelKey: 'filter.hasNone'     },
    { value: 'list_is_empty',     labelKey: 'filter.isEmpty'     },
    { value: 'list_is_not_empty', labelKey: 'filter.isNotEmpty'  },
  ],
  enum: [
    { value: 'equals',       labelKey: 'filter.equals'       },
    { value: 'not_equals',   labelKey: 'filter.notEquals'    },
    { value: 'in',           labelKey: 'filter.isOneOf'      },
    { value: 'not_in',       labelKey: 'filter.isNotOneOf'   },
    { value: 'is_empty',     labelKey: 'filter.isEmpty'      },
    { value: 'is_not_empty', labelKey: 'filter.isNotEmpty'   },
  ],
}

const NO_VALUE_OPS = new Set<FilterOperator>([
  'is_empty', 'is_not_empty', 'today', 'last_7_days', 'last_30_days',
  'list_is_empty', 'list_is_not_empty',
])

/** Gli operatori che vogliono una LISTA di valori scelti, non un valore solo. */
const MULTI_VALUE_OPS = new Set<FilterOperator>(['in', 'not_in', 'has_any', 'has_all', 'has_none'])

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultOperator(type: FieldConfig['type']): FilterOperator {
  if (type === 'date') return 'after'
  if (type === 'enum') return 'equals'
  if (type === 'multi_enum') return 'has_any'
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



// ── ValueInput ────────────────────────────────────────────────────────────────

function ValueInput({
  rule,
  fieldCfg,
  onChange,
  n,
}: {
  rule:     FilterRule
  fieldCfg: FieldConfig | undefined
  onChange: (partial: Partial<FilterRule>) => void
  /** Numero della condizione (da 1): dà il nome accessibile ai controlli. */
  n:        number
}) {
  const { t } = useTranslation()
  if (!fieldCfg || NO_VALUE_OPS.has(rule.operator)) return null

  const type = fieldCfg.type

  if (rule.operator === 'between') {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Input
          type="date"
          aria-label={t('filter.valueFromAria', { n })}
          value={typeof rule.value === 'string' ? rule.value : ''}
          onChange={(e) => onChange({ value: e.target.value })}
        />
        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('filter.betweenAnd')}</span>
        <Input
          type="date"
          aria-label={t('filter.valueToAria', { n })}
          value={rule.value2 ?? ''}
          onChange={(e) => onChange({ value2: e.target.value })}
        />
      </div>
    )
  }

  if (MULTI_VALUE_OPS.has(rule.operator) && (type === 'enum' || type === 'multi_enum')) {
    const opts     = fieldCfg.options ?? []
    const selected = Array.isArray(rule.value) ? rule.value : []
    const toggle   = (v: string) => {
      const next = selected.includes(v)
        ? selected.filter((x) => x !== v)
        : [...selected, v]
      onChange({ value: next })
    }
    return (
      <div role="group" aria-label={t('filter.valueAria', { n })} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {opts.map((opt) => (
          <label
            key={opt.value}
            style={{
              display:         'flex',
              alignItems:      'center',
              gap:             4,
              fontSize:        11,
              padding:         '2px 8px',
              borderRadius:    4,
              border:          `1px solid ${selected.includes(opt.value) ? 'var(--color-trigger-manual)' : colors.border}`,
              backgroundColor: selected.includes(opt.value) ? alpha.brand08 : colors.white,
              color:           selected.includes(opt.value) ? 'var(--color-brand)' : 'var(--color-slate)',
              cursor:          'pointer',
              userSelect:      'none',
            }}
          >
            <input
              type="checkbox"
              checked={selected.includes(opt.value)}
              onChange={() => toggle(opt.value)}
              style={srOnlyStyle}
            />
            {opt.label}
          </label>
        ))}
      </div>
    )
  }

  if (type === 'enum') {
    return (
      <Select
        aria-label={t('filter.valueAria', { n })}
        value={typeof rule.value === 'string' ? rule.value : ''}
        onChange={(e) => onChange({ value: e.target.value })}
        style={{ minWidth: 140 }}
      >
        <option value="">{t('common.select')}</option>
        {(fieldCfg.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>
    )
  }

  if (type === 'date') {
    return (
      <Input
        type="date"
        aria-label={t('filter.valueAria', { n })}
        value={typeof rule.value === 'string' ? rule.value : ''}
        onChange={(e) => onChange({ value: e.target.value })}
        style={{ minWidth: 140 }}
      />
    )
  }

  return (
    <Input
      type="text"
      aria-label={t('filter.valueAria', { n })}
      value={typeof rule.value === 'string' ? rule.value : ''}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder={t('filter.valuePlaceholderText')}
      style={{ minWidth: 160 }}
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
      <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: `1px solid ${colors.border}` }}>
        {(['AND', 'OR'] as const).map((l) => (
          <button type="button"
            key={l}
            onClick={() => onChange(l)}
            style={{
              padding:         '2px 10px',
              fontSize:        10,
              fontWeight:      700,
              letterSpacing:   '0.04em',
              border:          'none',
              cursor:          'pointer',
              backgroundColor: value === l ? 'var(--color-brand)' : colors.white,
              color:           value === l ? colors.white : 'var(--color-slate-light)',
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
  /**
   * Regole già attive all'apertura (es. lette dall'URL dalla pagina): il
   * pannello parte aperto e le mostra; NON chiama onApply da solo — è la
   * pagina che le ha già applicate alla query.
   */
  initialRules?: FilterRule[]
}

export function FilterBuilder({ fields, onApply, initialRules }: FilterBuilderProps) {
  const { t } = useTranslation()
  const [open,  setOpen]  = useState((initialRules?.length ?? 0) > 0)
  const [rules, setRules] = useState<FilterRule[]>(initialRules ?? [])

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
      // «fra» vuole DUE estremi (revisione totale · F-37): bastava che non
      // fossero null, quindi un secondo campo lasciato vuoto veniva
      // serializzato e mandato al server, che lo rifiutava — e l'utente non
      // sapeva quale filtro fosse sbagliato.
      if (r.operator === 'between') return !!r.value && !!r.value2
      if (MULTI_VALUE_OPS.has(r.operator))
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
        <button type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            display:         'flex',
            alignItems:      'center',
            gap:             6,
            padding:         '5px 10px',
            borderRadius:    6,
            border:          `1px solid ${colors.border}`,
            backgroundColor: activeCount > 0 ? alpha.brand08 : colors.white,
            color:           activeCount > 0 ? 'var(--color-brand)' : 'var(--color-slate)',
            fontSize:        12,
            cursor:          'pointer',
            fontWeight:      activeCount > 0 ? 600 : 400,
          }}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t('filter.advancedFilters')}
          {activeCount > 0 && (
            <Pill bg="var(--color-brand)" color={colors.white} radius={8} style={{ fontSize: 'var(--font-size-label)', fontWeight: 700 }}>
              {activeCount}
            </Pill>
          )}
        </button>

        {open && (
          <>
            <Button variant="secondary" size="xs"
              onClick={addRule}
            >
              <Plus size={13} />
              {t('filter.addFilter')}
            </Button>

            <div style={{ flex: 1 }} />

            <Button variant="primary" size="xs"
              onClick={handleApply}
            >
              {t('common.apply')}
            </Button>

            <Button variant="secondary" size="xs"
              onClick={handleReset}
            >
              {t('common.reset')}
            </Button>
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
              const tuttiGliOperatori = OPERATORS_BY_TYPE[fieldType] ?? OPERATORS_BY_TYPE.text
              const ammessi = fieldCfg?.operators
              const operators = ammessi ? tuttiGliOperatori.filter((op) => ammessi.includes(op.value)) : tuttiGliOperatori

              return (
                <div key={rule.id}>
                  {/* Rule row */}
                  <div style={{
                    display:      'flex',
                    alignItems:   'center',
                    gap:          8,
                    padding:      '8px 10px',
                    border:       `1px solid ${colors.border}`,
                    borderRadius: 4,
                    backgroundColor: colors.white,
                  }}>
                    {/* Field selector */}
                    <Select
                      aria-label={t('filter.fieldAria', { n: idx + 1 })}
                      value={rule.field}
                      onChange={(e) => updateRule(rule.id, { field: e.target.value })}
                      style={{ minWidth: 140, color: rule.field ? 'var(--color-slate-dark)' : 'var(--color-slate-light)' }}
                    >
                      <option value="">{t('filter.selectField')}</option>
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </Select>

                    {/* Operator selector — visibile solo dopo aver scelto il campo */}
                    {rule.field && (
                      <Select
                        aria-label={t('filter.operatorAria', { n: idx + 1 })}
                        value={rule.operator}
                        onChange={(e) => updateRule(rule.id, { operator: e.target.value as FilterOperator })}
                        style={{ minWidth: 140 }}
                      >
                        {operators.map((op) => (
                          <option key={op.value} value={op.value}>{t(op.labelKey)}</option>
                        ))}
                      </Select>
                    )}

                    {/* Value input — visibile solo dopo aver scelto campo e operatore */}
                    {rule.field && (
                      <div style={{ flex: 1 }}>
                        <ValueInput
                          rule={rule}
                          fieldCfg={fieldCfg}
                          onChange={(p) => updateRule(rule.id, p)}
                          n={idx + 1}
                        />
                      </div>
                    )}

                    {/* Remove */}
                    <button className="hover-danger" type="button"
                      aria-label={t('filter.removeAria', { n: idx + 1 })}
                      onClick={() => removeRule(rule.id)}
                      style={{
                        display:         'flex',
                        alignItems:      'center',
                        justifyContent:  'center',
                        width:           24,
                        height:          24,
                        borderRadius:    4,
                        border:          `1px solid ${palette.danger.border}`,
                        backgroundColor: colors.white,
                        color:           'var(--color-danger)',
                        cursor:          'pointer',
                        flexShrink:      0,
                      }}
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
