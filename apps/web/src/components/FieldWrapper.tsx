import { Children, cloneElement, isValidElement, useId, type ReactNode, type CSSProperties, type ReactElement } from 'react'

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
 *
 * L'etichetta è LEGATA al controllo (secondo giro UI del 15 set 2026): la
 * `<label>` stava sopra un `<input>` senza `id`, e per un lettore di schermo il
 * titolo e la descrizione del nuovo incident non avevano nome. Con un solo
 * controllo come figlio, gli si dà l'id (se non ne ha uno), e l'errore gli si
 * lega con `aria-invalid` e `aria-describedby`.
 */
export function FieldWrapper({ visible, required, label, error, children, style }: Props) {
  const uid = useId()
  const only = Children.count(children) === 1 && isValidElement(children) ? children as ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }> : null
  const controlId = only ? (only.props.id ?? uid) : undefined
  const errorId = `${uid}-error`
  const child = only
    ? cloneElement(only, { id: controlId, 'aria-invalid': error ? true : only.props['aria-invalid'], 'aria-describedby': error ? errorId : only.props['aria-describedby'] })
    : children
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
        <label htmlFor={controlId} style={{
          display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600,
          color: error ? 'var(--color-trigger-sla-breach)' : 'var(--color-slate-light)',
          textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
        }}>
          {label}
          {required && <span style={{ color: 'var(--color-trigger-sla-breach)', marginLeft: 3 }}>*</span>}
        </label>
      )}
      {child}
      {error && (
        <div id={errorId} style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-trigger-sla-breach)', marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  )
}
