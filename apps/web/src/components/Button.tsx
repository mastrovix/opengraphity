/**
 * Design-system Button — THE button of the app (E-09). Variants replicate the
 * visuals that used to be duplicated as `btnPrimary/btnSecondary/btnDanger`
 * style objects and inline `<button style={{…}}>`:
 *
 * - primary:   brand background, white text (the "Nuovo X" header buttons)
 * - secondary: white background, 1px border, slate text (Annulla / secondary actions)
 * - danger:    white background, red border + text (destructive row actions)
 * - ghost:     no background, no border (back-links, inline text actions)
 * - icon:      square icon-only button, secondary look — REQUIRES `aria-label`
 *              (or `title`, which is used as the accessible name too)
 *
 * Sizes map to the recurring paddings:
 * - sm (default): 6px 14px, font-size-card-title (primary) — list-header buttons
 * - xs:           4px 12px, font-size-body — modal action buttons / row actions
 *
 * `type` defaults to "button" so a Button inside `<Modal as="form">` never
 * submits by accident; pass `type="submit"` explicitly for the submit action.
 *
 * NOTE: this file lives in components/ (not components/ui/) because the
 * shadcn `ui/button.tsx` used to exist and macOS filesystems are
 * case-insensitive; the path is kept stable for the ~30 importers.
 *
 * Use `style` only for pinpoint overrides (e.g. a one-off width); do not
 * rebuild whole button styles inline in pages.
 *
 * AN ACTION IN FLIGHT IS NOT STARTED TWICE (review of 23 Sep 2026). When
 * `onClick` returns a promise the button is disabled (and `aria-busy`) until
 * it settles, and a second click in between does nothing. A double click on
 * «Create» made two SLA policies, two triggers, two channels: the rule lives
 * here, once, for every button — a handler only has to RETURN its promise
 * (`onClick={() => save()}`, never `() => void save()`; a test holds the
 * whole app to it).
 */
import { useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { colors, palette } from '@/lib/tokens'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'icon'
export type ButtonSize = 'sm' | 'xs'

export interface ButtonProps {
  children?: ReactNode
  /** A returned promise keeps the button disabled until it settles. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<unknown>
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  variant?: ButtonVariant
  size?: ButtonSize
  /** Optional icon rendered before the text (gap 6). */
  icon?: ReactNode
  /** Pinpoint overrides only — merged last. */
  style?: CSSProperties
  title?: string
  autoFocus?: boolean
  'aria-label'?: string
  'aria-expanded'?: boolean
  'aria-pressed'?: boolean
  /** The id of what describes the button (e.g. the value a «Copy» button copies, when several sit together). */
  'aria-describedby'?: string
  className?: string
}

// 26 Sep 2026: a size smaller (they were 36-38 px tall with 12-13 px text; see the button rule in index.css).
const PADDING: Record<ButtonSize, string> = {
  sm: '6px 14px',
  xs: '4px 12px',
}

/** primary font size follows the size; secondary always uses body size (as in the originals). */
const PRIMARY_FONT: Record<ButtonSize, string> = {
  sm: 'var(--font-size-card-title)',
  xs: 'var(--font-size-body)',
}

export function Button({
  children,
  onClick,
  disabled = false,
  type = 'button',
  variant = 'primary',
  size = 'sm',
  icon,
  style,
  title,
  autoFocus,
  className,
  ...aria
}: ButtonProps) {
  const [busy, setBusy] = useState(false)
  // The ref answers at once: two clicks in the same frame both see `busy` false.
  const inFlight = useRef(false)
  const handleClick = onClick && ((e: MouseEvent<HTMLButtonElement>) => {
    if (inFlight.current) return
    const out = onClick(e)
    if (!out || typeof (out as Promise<unknown>).then !== 'function') return
    inFlight.current = true
    setBusy(true)
    const done = () => { inFlight.current = false; setBusy(false) }
    // A failed action frees the button and is written to the console: the
    // handler says it to the person (a toast), the button only must not make
    // it an unhandled rejection — nor hide it.
    void (out as Promise<unknown>).then(done, (err: unknown) => {
      done()
      console.error('[Button] the action failed', err)
    })
  })
  disabled = disabled || busy
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  }

  let variantStyle: CSSProperties
  switch (variant) {
    case 'primary':
      variantStyle = {
        padding: PADDING[size],
        backgroundColor: 'var(--color-brand)',
        color: colors.white,
        border: 'none',
        fontSize: PRIMARY_FONT[size],
        fontWeight: 500,
        transition: 'background-color 150ms',
      }
      break
    case 'secondary':
      variantStyle = {
        padding: PADDING[size],
        background: colors.white,
        color: 'var(--color-slate)',
        border: '1px solid var(--border)',
        fontSize: 'var(--font-size-body)',
      }
      break
    case 'danger':
      variantStyle = {
        padding: PADDING[size],
        background: colors.white,
        color: 'var(--color-danger)',
        border: `1px solid ${palette.danger.border}`,
        fontSize: 'var(--font-size-body)',
      }
      break
    case 'ghost':
      variantStyle = {
        padding: 0,
        background: 'none',
        border: 'none',
        borderRadius: 0,
      }
      break
    case 'icon':
      variantStyle = {
        padding: size === 'sm' ? 6 : 4,
        background: colors.white,
        color: 'var(--color-slate)',
        border: '1px solid var(--border)',
        lineHeight: 0,
      }
      break
  }

  const merged: CSSProperties = { ...base, ...variantStyle, ...style }

  // Brand hover only when the brand background is actually in effect.
  const hasBgOverride = style?.background !== undefined || style?.backgroundColor !== undefined
  const hoverable = variant === 'primary' && !disabled && !hasBgOverride

  const ariaLabel = aria['aria-label'] ?? (variant === 'icon' ? title : undefined)
  if (variant === 'icon' && !ariaLabel && import.meta.env.DEV) {
    console.error('[Button] variant="icon" needs aria-label or title (an accessible name)')
  }

  return (
    <button
      type={type}
      onClick={handleClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      title={title}
      // eslint-disable-next-line jsx-a11y/no-autofocus -- passthrough: la scelta (e la sua giustificazione) sta nel call site, es. il bottone sicuro di ConfirmModal
      autoFocus={autoFocus}
      className={className}
      aria-label={ariaLabel}
      aria-expanded={aria['aria-expanded']}
      aria-pressed={aria['aria-pressed']}
      aria-describedby={aria['aria-describedby']}
      style={merged}
      onMouseEnter={hoverable ? (e) => { e.currentTarget.style.backgroundColor = 'var(--color-brand-hover)' } : undefined}
      onMouseLeave={hoverable ? (e) => { e.currentTarget.style.backgroundColor = 'var(--color-brand)' } : undefined}
    >
      {icon}
      {children}
    </button>
  )
}
