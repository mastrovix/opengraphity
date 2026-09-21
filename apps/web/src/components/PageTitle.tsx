import { cloneElement, isValidElement, type ReactNode, type CSSProperties } from 'react'

/**
 * LA MISURA E IL COLORE DELL'ICONA DEL TITOLO SONO DEL TITOLO, non della pagina.
 *
 * Erano scritti in ogni pagina (`<Gauge size={22} color="var(--color-icon-accent)" />`),
 * e quindi derivavano: l'SLA Report e il Catalogo servizi avevano `size={20}`
 * senza colore, l'Assistente AI `size={20}` color brand. Un test cercava la
 * forma giusta con una regex, e un'icona scritta in un'altra forma non la
 * vedeva nemmeno. Qui la regola non si controlla: si APPLICA — qualunque
 * misura e colore arrivino, il titolo li sostituisce con questi.
 */
const TITLE_ICON_SIZE  = 22
const TITLE_ICON_COLOR = 'var(--color-icon-accent)'

interface PageTitleProps {
  /** L'icona, es. `<AlertCircle />`: misura e colore li impone PageTitle. */
  icon: ReactNode
  children: ReactNode
  style?: CSSProperties
}

/**
 * Consistent page-level h1 with an icon perfectly centred on the text baseline.
 *
 * The icon is wrapped in a zero-line-height span so it participates only in
 * flex alignment and never inherits the h1 line-height that would push it up.
 */
export function PageTitle({ icon, children, style }: PageTitleProps) {
  return (
    <h1
      style={{
        display:       'flex',
        alignItems:    'center',
        gap:           '0.5rem',
        fontSize:      24,
        fontWeight:    600,
        color:         'var(--color-slate-dark)',
        letterSpacing: '-0.01em',
        margin:        0,
        lineHeight:    1.25,
        ...style,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0 }}>
        {isValidElement<{ size?: number; color?: string }>(icon)
          ? cloneElement(icon, { size: TITLE_ICON_SIZE, color: TITLE_ICON_COLOR })
          : icon}
      </span>
      {children}
    </h1>
  )
}
