/**
 * Design-system Button — extracts the inline-style button patterns duplicated
 * across pages. Variants replicate the existing visuals EXACTLY:
 *
 * - primary:   brand background, white text (the "Nuovo X" header buttons)
 * - secondary: white background, 1px #e5e7eb border, slate text (Annulla / secondary actions)
 * - ghost:     no background, no border (back-links, icon buttons)
 *
 * Sizes map to the recurring paddings:
 * - sm (default): 8px 16px, font-size-card-title (primary) — list-header buttons
 * - xs:           6px 14px, font-size-body — modal action buttons
 *
 * NOTE: this file lives in components/ (not components/ui/) because
 * components/ui/button.tsx (shadcn) already exists and macOS filesystems are
 * case-insensitive — Button.tsx and button.tsx cannot coexist there.
 *
 * Use `style` only for pinpoint overrides (e.g. a one-off color); do not
 * rebuild whole button styles inline in pages.
 */
import type { CSSProperties, MouseEvent, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
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
}: ButtonProps) {
  const base: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
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
        border: '1px solid #e5e7eb',
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
  }

  const merged: CSSProperties = { ...base, ...variantStyle, ...style }

  // Brand hover only when the brand background is actually in effect.
  const hasBgOverride = style?.background !== undefined || style?.backgroundColor !== undefined
  const hoverable = variant === 'primary' && !disabled && !hasBgOverride

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={merged}
      onMouseEnter={hoverable ? (e) => { e.currentTarget.style.backgroundColor = 'var(--color-brand-hover)' } : undefined}
      onMouseLeave={hoverable ? (e) => { e.currentTarget.style.backgroundColor = 'var(--color-brand)' } : undefined}
    >
      {icon}
      {children}
    </button>
  )
}
