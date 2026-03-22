import { useState, useEffect } from 'react'
import type { CITypeDef, CIFieldDef } from '@/contexts/MetamodelContext'
import { validateCI, isFieldVisible, getFieldDefault } from '@/lib/ciValidator'

// ── Style constants ────────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  width:           '100%',
  padding:         '10px 14px',
  border:          '1px solid #e5e7eb',
  borderRadius:    6,
  fontSize:        14,
  color:           '#0f172a',
  outline:         'none',
  backgroundColor: '#ffffff',
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
      e.currentTarget.style.borderColor = '#0284c7'
      e.currentTarget.style.boxShadow   = '0 0 0 3px #ecfeff'
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = hasError ? '#dc2626' : '#e5e7eb'
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
  value,
  error,
  onChange,
}: {
  field: CIFieldDef
  value: unknown
  error?: string
  onChange: (val: unknown) => void
}) {
  const hasError = Boolean(error)
  const borderColor = hasError ? '#dc2626' : '#e5e7eb'

  switch (field.fieldType) {
    case 'boolean':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id={field.name}
            checked={Boolean(value)}
            onChange={e => onChange(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          <label htmlFor={field.name} style={{ fontSize: 14, color: '#64748b', cursor: 'pointer' }}>
            {field.label}
          </label>
        </div>
      )

    case 'number':
      return (
        <input
          type="number"
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
          value={value !== null && value !== undefined ? String(value) : ''}
          onChange={e => onChange(e.target.value || null)}
          style={{ ...inputBase, borderColor }}
          {...focusHandlers(hasError)}
        />
      )

    case 'enum':
      return (
        <select
          value={value !== null && value !== undefined ? String(value) : ''}
          onChange={e => onChange(e.target.value || null)}
          style={{ ...selectBase, borderColor }}
          {...focusHandlers(hasError)}
        >
          <option value="">— seleziona —</option>
          {field.enumValues.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )

    default: // string
      return (
        <input
          type="text"
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
  const [formValues, setFormValues] = useState<Record<string, unknown>>(initialValues)
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [globalError, setGlobalError] = useState<string | undefined>()
  const [visibilityMap, setVisibilityMap] = useState<Record<string, boolean>>({})
  const [submitting, setSubmitting] = useState(false)

  // Evaluate default scripts when form values change
  useEffect(() => {
    let cancelled = false

    async function applyDefaults() {
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
    }

    applyDefaults()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once on mount to apply initial defaults

  // Evaluate visibility scripts when form values change
  useEffect(() => {
    let cancelled = false

    async function updateVisibility() {
      const map: Record<string, boolean> = {}
      for (const field of ciType.fields) {
        map[field.name] = await isFieldVisible(field.name, formValues, ciType)
      }
      if (!cancelled) setVisibilityMap(map)
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

    const result = await validateCI(formValues, ciType)
    if (!result.valid) {
      setValidationErrors(result.errors)
      setGlobalError(result.globalError)
      setSubmitting(false)
      return
    }

    try {
      await onSubmit(formValues)
    } finally {
      setSubmitting(false)
    }
  }

  const sortedFields = [...ciType.fields]
    .filter(f => !f.isSystem)
    .sort((a, b) => a.order - b.order)

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {globalError && (
        <div style={{
          padding:      '10px 14px',
          background:   '#fef2f2',
          border:       '1px solid #fecaca',
          borderRadius: 6,
          color:        '#dc2626',
          fontSize:     14,
        }}>
          {globalError}
        </div>
      )}

      {sortedFields.map(field => {
        // Hide fields whose visibilityScript evaluates to false (default visible while loading)
        const visible = visibilityMap[field.name] !== false
        if (!visible) return null

        const isCheckbox = field.fieldType === 'boolean'
        const error = validationErrors[field.name]

        return (
          <div key={field.name}>
            {!isCheckbox && (
              <label style={{
                display:      'block',
                fontSize:     13,
                fontWeight:   500,
                color:        '#64748b',
                marginBottom: 6,
              }}>
                {field.label}
                {field.required && <span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>}
              </label>
            )}

            <FieldRenderer
              field={field}
              value={formValues[field.name]}
              error={error}
              onChange={val => handleChange(field.name, val)}
            />

            {error && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#dc2626' }}>
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
            border:       '1px solid #e5e7eb',
            borderRadius: 6,
            background:   '#ffffff',
            fontSize:     14,
            cursor:       'pointer',
            color:        '#64748b',
          }}
        >
          Annulla
        </button>
        <button
          type="submit"
          disabled={submitting || loading}
          style={{
            padding:      '9px 20px',
            border:       'none',
            borderRadius: 6,
            background:   submitting || loading ? '#67e8f9' : '#0284c7',
            color:        '#ffffff',
            fontSize:     14,
            fontWeight:   500,
            cursor:       submitting || loading ? 'not-allowed' : 'pointer',
            transition:   'background 150ms',
          }}
        >
          {submitting ? 'Salvataggio...' : 'Salva'}
        </button>
      </div>
    </form>
  )
}
