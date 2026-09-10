import { useState, useEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { CITypeDef, CIFieldDef } from '@/contexts/MetamodelContext'
import { validateCI, isFieldVisible, getFieldDefault } from '@/lib/ciValidator'
import { useCIBaseEnums } from '@/lib/ciEnums'
import { colors, palette } from '@/lib/tokens'

// Base (__base__) fields every CI shares — the Create input requires `name`
// and accepts status/environment/description. They aren't in a type's own
// field list, so the form renders them explicitly; i valori di status e
// environment vengono dal tipo base del metamodello (useCIBaseEnums).

/** Attesa dopo l'ultima modifica prima di rieseguire i default_script (F-13). */
const DEFAULTS_DEBOUNCE_MS = 300

// ── Style constants ────────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          `1px solid ${colors.border}`,
  borderRadius:    6,
  fontSize:        14,
  color:           'var(--color-slate-dark)',
  outline:         'none',
  backgroundColor: colors.white,
  boxSizing:       'border-box',
  transition:      'border-color 150ms, box-shadow 150ms',
}

const selectBase: React.CSSProperties = {
  ...inputBase,
  appearance:         'none',
  backgroundImage:    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat:   'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight:       36,
  cursor:             'pointer',
}

function focusHandlers(hasError: boolean) {
  return {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = 'var(--color-brand)'
      e.currentTarget.style.boxShadow   = `0 0 0 3px ${colors.brandLight}`
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = hasError ? 'var(--color-trigger-sla-breach)' : colors.border
      e.currentTarget.style.boxShadow   = 'none'
    },
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface CIDynamicFormProps {
  ciType: CITypeDef
  initialValues?: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  onCancel: () => void
  loading?: boolean
}

// ── FieldRenderer ─────────────────────────────────────────────────────────────

function FieldRenderer({
  field,
  id,
  value,
  error,
  onChange,
}: {
  field: CIFieldDef
  /** id del controllo, associato alla label del campo (a11y) */
  id: string
  value: unknown
  error?: string
  onChange: (val: unknown) => void
}) {
  const { t } = useTranslation()
  const hasError = Boolean(error)
  const borderColor = hasError ? 'var(--color-trigger-sla-breach)' : colors.border

  switch (field.fieldType) {
    case 'boolean':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id={id}
            checked={Boolean(value)}
            onChange={e => onChange(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          <label htmlFor={id} style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer' }}>
            {field.label}
          </label>
        </div>
      )

    case 'number':
      return (
        <input
          type="number"
          id={id}
          value={value !== null && value !== undefined ? String(value) : ''}
          onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
          placeholder={field.label}
          style={{ ...inputBase, borderColor }}
          {...focusHandlers(hasError)}
        />
      )

    case 'date':
      return (
        <input
          type="date"
          id={id}
          value={value !== null && value !== undefined ? String(value) : ''}
          onChange={e => onChange(e.target.value || null)}
          style={{ ...inputBase, borderColor }}
          {...focusHandlers(hasError)}
        />
      )

    case 'enum':
      return (
        <select
          id={id}
          value={value !== null && value !== undefined ? String(value) : ''}
          onChange={e => onChange(e.target.value || null)}
          style={{ ...selectBase, borderColor }}
          {...focusHandlers(hasError)}
        >
          <option value="">{t('components.ciDynamicForm.selectOption')}</option>
          {field.enumValues.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )

    default: // string
      return (
        <input
          type="text"
          id={id}
          value={value !== null && value !== undefined ? String(value) : ''}
          onChange={e => onChange(e.target.value || null)}
          placeholder={field.label}
          style={{ ...inputBase, borderColor }}
          {...focusHandlers(hasError)}
        />
      )
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

export function CIDynamicForm({
  ciType,
  initialValues = {},
  onSubmit,
  onCancel,
  loading = false,
}: CIDynamicFormProps) {
  const { t } = useTranslation()
  // Prefisso unico per gli id label/controllo: la form può essere montata più volte (modal + anteprima designer)
  const baseId = useId()
  const fieldId = (name: string) => `${baseId}-${name}`
  const [formValues, setFormValues] = useState<Record<string, unknown>>(initialValues)
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState<string | undefined>()
  // Errore del sandbox di scripting del metamodello (WASM non compilabile o
  // script visibility/default rotto). Fail-fast: nessun fallback — la form si
  // blocca finché non è risolto, invece di indovinare uno stato.
  const [scriptError, setScriptError] = useState<string | undefined>()
  const [visibilityMap, setVisibilityMap] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)
  const baseEnums = useCIBaseEnums()

  // Default script: rieseguiti a ogni modifica dei valori (con debounce), non
  // solo al mount — un default che dipende da un altro campo (es. porta in
  // base al tipo di database) deve seguire quel campo. Il ciclo converge perché
  // si scrive solo quando il valore calcolato è diverso da quello corrente.
  useEffect(() => {
    let cancelled = false
    const hasDefaults = ciType.fields.some(f => f.defaultScript)
    if (!hasDefaults) return

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const updates: Record<string, unknown> = {}
          for (const field of ciType.fields) {
            if (!field.defaultScript) continue
            const computed = await getFieldDefault(field.name, formValues, ciType)
            const current = formValues[field.name]
            if (computed !== null && computed !== undefined && computed !== current) {
              updates[field.name] = computed
            }
          }
          if (!cancelled && Object.keys(updates).length > 0) {
            setFormValues(prev => ({ ...prev, ...updates }))
          }
        } catch (e) {
          if (!cancelled) setScriptError(e instanceof Error ? e.message : String(e))
        }
      })()
    }, DEFAULTS_DEBOUNCE_MS)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [formValues, ciType])

  // Evaluate visibility scripts when form values change
  useEffect(() => {
    let cancelled = false

    async function updateVisibility() {
      try {
        const map: Record<string, boolean> = {}
        for (const field of ciType.fields) {
          map[field.name] = await isFieldVisible(field.name, formValues, ciType)
        }
        if (!cancelled) {
          setVisibilityMap(map)
          setScriptError(undefined)
        }
      } catch (e) {
        if (!cancelled) setScriptError(e instanceof Error ? e.message : String(e))
      }
    }

    updateVisibility()
    return () => { cancelled = true }
  }, [formValues, ciType])

  function handleChange(fieldName: string, val: unknown) {
    setFormValues(prev => ({ ...prev, [fieldName]: val }))
    // Clear error on change
    if (validationErrors[fieldName]) {
      setValidationErrors(prev => {
        const next = { ...prev }
        delete next[fieldName]
        return next
      })
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setGlobalError(undefined)

    // Name is required by the Create input but isn't a type field
    if (!String(formValues['name'] ?? '').trim()) {
      setValidationErrors(prev => ({ ...prev, name: t('components.ciDynamicForm.nameRequired') }))
      setSubmitting(false)
      return
    }

    let result
    try {
      result = await validateCI(formValues, ciType)
    } catch (e) {
      // Sandbox non disponibile o validation_script rotto: fail-fast, niente submit.
      setScriptError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
      return
    }
    if (!result.valid) {
      setValidationErrors(result.errors)
      setGlobalError(result.globalError)
      setSubmitting(false)
      return
    }

    try {
      await onSubmit(formValues)
    } catch (e) {
      // Il server rivalida (required/validation_script lato API): il suo
      // messaggio va mostrato nella form, non solo in un toast del chiamante.
      setGlobalError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const sortedFields = [...ciType.fields]
    .filter(f => !f.isSystem)
    .sort((a, b) => a.order - b.order)

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {scriptError && (
        <div style={{
          padding:      '10px 14px',
          background:   'var(--color-danger-bg)',
          border:       `1px solid ${palette.danger.border}`,
          borderRadius: 6,
          color:        'var(--color-trigger-sla-breach)',
          fontSize:     14,
        }}>
          <strong>{t('components.ciDynamicForm.scriptError')}</strong> {scriptError}
        </div>
      )}

      {globalError && (
        <div style={{
          padding:      '10px 14px',
          background:   'var(--color-danger-bg)',
          border:       `1px solid ${palette.danger.border}`,
          borderRadius: 6,
          color:        'var(--color-trigger-sla-breach)',
          fontSize:     14,
        }}>
          {globalError}
        </div>
      )}

      {/* Base fields (name required + common attributes) */}
      <div>
        <label htmlFor={fieldId('name')} style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 6 }}>
          {t('pages.cmdb.name')}<span style={{ color: 'var(--color-trigger-sla-breach)', marginLeft: 2 }}>*</span>
        </label>
        {/* Niente autoFocus: nel modal di creazione è Modal a spostare il focus sul
            primo controllo; nelle anteprime del designer tipi non deve rubare il focus. */}
        <input
          type="text"
          id={fieldId('name')}
          value={String(formValues['name'] ?? '')}
          onChange={e => handleChange('name', e.target.value)}
          style={inputBase}
        />
        {validationErrors['name'] && (
          <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>
            {validationErrors['name']}
          </p>
        )}
      </div>
      {baseEnums.error && (
        <div style={{ padding: '8px 14px', background: 'var(--color-danger-bg)', border: `1px solid ${palette.danger.border}`, borderRadius: 6, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>
          <strong>{t('components.ciDynamicForm.metamodelError')}</strong> {baseEnums.error}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <label htmlFor={fieldId('status')} style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 6 }}>{t('pages.cmdb.status')}</label>
          <select id={fieldId('status')} value={String(formValues['status'] ?? '')} onChange={e => handleChange('status', e.target.value)} style={inputBase}>
            <option value="">—</option>
            {baseEnums.statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={fieldId('environment')} style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 6 }}>{t('pages.cmdb.environment')}</label>
          <select id={fieldId('environment')} value={String(formValues['environment'] ?? '')} onChange={e => handleChange('environment', e.target.value)} style={inputBase}>
            <option value="">—</option>
            {baseEnums.environments.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={fieldId('description')} style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 6 }}>{t('common.description')}</label>
        <textarea id={fieldId('description')} value={String(formValues['description'] ?? '')} onChange={e => handleChange('description', e.target.value)} rows={2} style={{ ...inputBase, resize: 'vertical' }} />
      </div>

      {sortedFields.map(field => {
        // Render only when visibility is confirmed true. No fallback: a field
        // is not shown on a guess while its visibility_script is still pending
        // or has failed (in which case scriptError blocks the whole form).
        const visible = visibilityMap[field.name] === true
        if (!visible) return null

        const isCheckbox = field.fieldType === 'boolean'
        const error = validationErrors[field.name]

        return (
          <div key={field.name}>
            {!isCheckbox && (
              <label htmlFor={fieldId(field.name)} style={{
                display:      'block',
                fontSize:     13,
                fontWeight:   500,
                color:        'var(--color-slate)',
                marginBottom: 6,
              }}>
                {field.label}
                {field.required && <span style={{ color: 'var(--color-trigger-sla-breach)', marginLeft: 2 }}>*</span>}
              </label>
            )}

            <FieldRenderer
              field={field}
              id={fieldId(field.name)}
              value={formValues[field.name]}
              error={error}
              onChange={val => handleChange(field.name, val)}
            />

            {error && (
              <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>
                {error}
              </p>
            )}
          </div>
        )
      })}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 8 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting || loading}
          style={{
            padding:      '9px 20px',
            border:       `1px solid ${colors.border}`,
            borderRadius: 6,
            background:   colors.white,
            fontSize:     14,
            cursor:       'pointer',
            color:        'var(--color-slate)',
          }}
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          disabled={submitting || loading || Boolean(scriptError)}
          style={{
            padding:      '9px 20px',
            border:       'none',
            borderRadius: 6,
            background:   submitting || loading || scriptError ? palette.teal.border : 'var(--color-brand)',
            color:        colors.white,
            fontSize:     14,
            fontWeight:   500,
            cursor:       submitting || loading || scriptError ? 'not-allowed' : 'pointer',
            transition:   'background 150ms',
          }}
        >
          {submitting ? t('components.ciDynamicForm.saving') : t('common.save')}
        </button>
      </div>
    </form>
  )
}
