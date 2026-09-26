/**
 * A SEARCH BOX: THE MAGNIFIER INSIDE THE FIELD (26 Sep 2026, wave 5 of «tutte
 * in fila»).
 *
 * Eight searches drew it themselves: a lucide icon or a «🔍» emoji, 13 to 16
 * px, 8 to 12 px from the edge, the text pushed 26 to 36 px to make room —
 * and when a wave of this refactor took the fields' own padding away, the
 * magnifier ended up over the text. Here the room for the icon is the box's.
 */
import type { CSSProperties, KeyboardEvent } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/FormControls'

export function SearchBox({ value, onChange, placeholder, ariaLabel, id, autoFocus, onKeyDown, style, inputStyle }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** The field's name when no label names it (`id` + a <label> otherwise). */
  ariaLabel?: string
  id?: string
  autoFocus?: boolean
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** The box's own place: width, margins, flex. */
  style?: CSSProperties
  inputStyle?: CSSProperties
}) {
  return (
    <span style={{ position: 'relative', display: 'flex', alignItems: 'center', ...style }}>
      <Search size={14} aria-hidden="true" style={{ position: 'absolute', left: 10, color: 'var(--color-slate-light)', pointerEvents: 'none' }} />
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- passthrough: the choice (and its reason) is the caller's, e.g. the search of a dialog the user just opened
        autoFocus={autoFocus}
        style={{ paddingLeft: 32, ...inputStyle }}
      />
    </span>
  )
}
