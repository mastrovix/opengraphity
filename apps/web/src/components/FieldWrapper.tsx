import type { ReactNode, CSSProperties } from 'react'

interface Props {
  visible:   boolean
  required?: boolean
  label?:    string
  error?:    string
  children:  ReactNode
  style?:    CSSProperties
}

/**
 * Wraps a form field with animated show/hide (opacity + max-height, 200ms).
 * When required=true and error is set, shows a red border hint under the label.
 */
export function FieldWrapper({ visible, required, label, error, children, style }: Props) {
  return (
    <div
      style={{
        overflow:      'hidden',
        maxHeight:     visible ? '600px' : '0',
        opacity:       visible ? 1 : 0,
        transition:    'max-height 200ms ease, opacity 200ms ease',
        pointerEvents: visible ? undefined : 'none',
        ...style,
      }}
    >
      {label && (
        <label style={{
          display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600,
          color: error ? 'var(--color-trigger-sla-breach)' : 'var(--color-slate-light)',
          textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
        }}>
          {label}
          {required && <span style={{ color: 'var(--color-trigger-sla-breach)', marginLeft: 3 }}>*</span>}
        </label>
      )}
      {children}
      {error && (
        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-trigger-sla-breach)', marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  )
}
