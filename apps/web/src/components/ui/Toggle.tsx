/**
 * Accessible on/off switch (E-10 / E-14). Replaces the six page-local
 * `<div onClick>` / `<button>` toggles: `role="switch"`, `aria-checked`,
 * native keyboard support (Space / Enter) and a required accessible name.
 */
import type { CSSProperties } from 'react'

interface ToggleProps {
  checked:   boolean
  onChange:  (checked: boolean) => void
  /** Accessible name (what is being switched on/off). */
  label:     string
  /**
   * Id of a visible element that names the switch (e.g. the text next to it):
   * when given it replaces `aria-label`, so a screen reader announces the name
   * once and clicking the text toggles the switch through `htmlFor`-like `id`.
   */
  labelledBy?: string
  id?:       string
  disabled?: boolean
  /** Track size in px (default 36 × 20). */
  size?:     'sm' | 'md'
  style?:    CSSProperties
}

export function Toggle({ checked, onChange, label, labelledBy, id, disabled = false, size = 'md', style }: ToggleProps) {
  const w = size === 'sm' ? 28 : 36
  const h = size === 'sm' ? 16 : 20
  const knob = h - 4
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      id={id}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: w, height: h, borderRadius: h / 2, border: 'none', padding: 0,
        background: checked ? 'var(--color-brand)' : '#cbd5e1',
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1, transition: 'background .2s', flexShrink: 0,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute', top: 2, left: checked ? w - knob - 2 : 2,
          width: knob, height: knob, borderRadius: '50%', background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,.15)', transition: 'left .2s',
        }}
      />
    </button>
  )
}
