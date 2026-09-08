/**
 * Icona React di un tipo CI, disegnata dal registro unico `ciIconPaths.ts`
 * (stessi path usati dai grafi D3): una chiave sconosciuta è un "?" rosso,
 * non un Box silenzioso come prima.
 */
import { createElement } from 'react'
import { iconPathsOrError, isBrokenIconKey, BROKEN_ICON_COLOR, CI_ICON_PATHS } from '@/lib/ciIconPaths'

export function CIIcon({
  icon,
  size = 20,
  color,
  style,
}: {
  icon: string
  size?: number
  color?: string
  style?: React.CSSProperties
}) {
  const known  = isBrokenIconKey(icon) ? false : icon in CI_ICON_PATHS
  const nodes  = iconPathsOrError(icon)
  const stroke = known ? (color ?? 'currentColor') : BROKEN_ICON_COLOR
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-label={known ? icon : `icona sconosciuta: ${icon}`}
      role="img"
    >
      {nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  )
}
