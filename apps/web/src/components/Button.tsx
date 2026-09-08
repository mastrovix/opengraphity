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
 * - sm (default): 8px 16px, font-size-card-title (primary) — list-header buttons
 * - xs:           6px 14px, font-size-body — modal action buttons / row actions
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
 */
import type { CSSProperties, MouseEvent, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'icon'
export type ButtonSize = 'sm' | 'xs'

export interface ButtonProps {
  children?: ReactNode
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
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
  className?: string
}

const PADDING: Record<ButtonSize, string> = {
  sm: '8px 16px',
  xs: '6px 14px',
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
        color: '#fff',
        border: 'none',
        fontSize: PRIMARY_FONT[size],
        fontWeight: 500,
        transition: 'background-color 150ms',
      }
      break
    case 'secondary':
      variantStyle = {
        padding: PADDING[size],
        background: '#fff',
        color: 'var(--color-slate)',
        border: '1px solid var(--border)',
        fontSize: 'var(--font-size-body)',
      }
      break
    case 'danger':
      variantStyle = {
        padding: PADDING[size],
        background: '#fff',
        color: 'var(--color-danger)',
        border: '1px solid #fecaca',
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
        background: '#fff',
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
    console.error('[Button] variant="icon" richiede aria-label o title (nome accessibile)')
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      autoFocus={autoFocus}
      className={className}
      aria-label={ariaLabel}
      aria-expanded={aria['aria-expanded']}
      aria-pressed={aria['aria-pressed']}
      style={merged}
      onMouseEnter={hoverable ? (e) => { e.currentTarget.style.backgroundColor = 'var(--color-brand-hover)' } : undefined}
      onMouseLeave={hoverable ? (e) => { e.currentTarget.style.backgroundColor = 'var(--color-brand)' } : undefined}
    >
      {icon}
      {children}
    </button>
  )
}
