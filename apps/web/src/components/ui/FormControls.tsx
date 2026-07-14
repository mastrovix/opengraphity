import type { CSSProperties, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

/**
 * Shared form controls replicating the dominant inline style used across
 * the app (see CIDetailPage's inputStyle). Pass `style` for per-case
 * overrides; it is merged last.
 */
export const controlStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 10px',
  fontSize: 'var(--font-size-body)', borderRadius: 6,
  border: '1px solid #d1d5db', background: '#fff',
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
  outline: 'none',
}

export function Input({ style, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} style={{ ...controlStyle, ...style }} />
}

export function Select({ style, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} style={{ ...controlStyle, ...style }}>{children}</select>
}

export function Textarea({ style, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} style={{ ...controlStyle, resize: 'vertical', lineHeight: 1.6, ...style }} />
}

/** Uppercase field label used above form controls in detail/edit views. */
export function FieldLabel({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 500, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, ...style }}>
      {children}
    </div>
  )
}
