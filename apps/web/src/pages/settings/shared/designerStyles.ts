// Shared style constants for CI Type Designer and ITIL Type Designer

export const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}

export const selectS: React.CSSProperties = {
  ...inputS,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}

export const textareaS: React.CSSProperties = {
  ...inputS, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 12, resize: 'vertical', minHeight: 80,
}

export const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}

export const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', border: 'none', borderRadius: 6, background: '#38bdf8',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms',
}

export const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 13, cursor: 'pointer',
}

export const btnDanger: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: '#ef4444', fontSize: 12, cursor: 'pointer',
}

export const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum'] as const

export interface EnumTypeRef {
  id: string
  label: string
  values: string[]
  scope: string
}

/** Chip preview for enum values */
export function enumChipStyle(): React.CSSProperties {
  return { padding: '2px 8px', background: '#f0f4ff', borderRadius: 12, fontSize: 11, color: 'var(--color-brand)' }
}

/** Active card style (selected state in designer type list) */
export const activeCardStyle: React.CSSProperties = {
  border: '1px solid var(--color-brand)',
  background: '#f0f9ff',
  color: 'var(--color-brand)',
}

/** Inactive card style */
export const inactiveCardStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  background: '#fff',
  color: 'var(--color-slate-dark)',
}
