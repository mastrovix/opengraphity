/**
 * Il valore da dare a un `<input type="color">`, che accetta solo `#rrggbb`.
 *
 * Giro UI del 15 set 2026 · U-15: un tipo CI nuovo nasce col colore del
 * marchio, salvato come token (`var(--color-brand)`, così segue il tema). Il
 * selettore però non capisce un token e mostrava nero, come se il colore fosse
 * nero. Qui il token si risolve nel colore che il browser sta usando; se non
 * si riesce a risolverlo il chiamante lo dice, non inventa un colore.
 */

const TOKEN = /^var\((--[\w-]+)\)$/
const HEX6 = /^#[\da-f]{6}$/i
const HEX3 = /^#([\da-f])([\da-f])([\da-f])$/i
const RGB = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i

const byte = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')

/** `#abc`, `#aabbcc`, `rgb(…)` → `#aabbcc`; altrimenti `null`. */
export function toColorInputHex(color: string): string | null {
  const c = color.trim()
  if (HEX6.test(c)) return c.toLowerCase()
  const short = HEX3.exec(c)
  if (short) return `#${short[1]!.repeat(2)}${short[2]!.repeat(2)}${short[3]!.repeat(2)}`.toLowerCase()
  const rgb = RGB.exec(c)
  if (rgb) return `#${byte(Number(rgb[1]))}${byte(Number(rgb[2]))}${byte(Number(rgb[3]))}`
  return null
}

/** Il colore salvato è un token CSS (`var(--…)`)? */
export function isColorToken(color: string): boolean {
  return TOKEN.test(color.trim())
}

/** Il valore per il selettore: il colore stesso, o il token risolto da `:root`. `null` se non si risolve. */
export function colorInputValue(color: string, root: Element | null = typeof document === 'undefined' ? null : document.documentElement): string | null {
  const token = TOKEN.exec(color.trim())
  if (!token) return toColorInputHex(color)
  if (!root) return null
  return toColorInputHex(getComputedStyle(root).getPropertyValue(token[1]!))
}
