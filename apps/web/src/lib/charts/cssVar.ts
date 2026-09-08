/**
 * Risolve un token CSS (`--color-slate`, `--font-size-body`…) nel valore
 * concreto letto da `:root`.
 *
 * Serve a ECharts: il layout del testo è calcolato con `fontSize` numerico e
 * i colori finiscono nel canvas/SVG interno, dove `var(--x)` NON viene
 * risolto (funziona solo nel tooltip HTML). Prima i grafici ricevevano
 * `fontSize: 'var(--font-size-body)'` e cadevano sul default.
 *
 * Fail-loud: una variabile assente lancia — è un errore di configurazione
 * dei token, non un caso da coprire con un default.
 */

const cache = new Map<string, string>()

export function cssVar(name: string): string {
  const hit = cache.get(name)
  if (hit !== undefined) return hit
  if (typeof document === 'undefined') {
    throw new Error(`[cssVar] ${name}: nessun document (chiamata fuori dal browser)`)
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw) throw new Error(`[cssVar] variabile CSS non definita in :root: ${name}`)
  cache.set(name, raw)
  return raw
}

/** Token numerico in px ("12px" → 12). */
export function cssVarPx(name: string): number {
  const raw = cssVar(name)
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) throw new Error(`[cssVar] ${name} non è una misura in px: "${raw}"`)
  return n
}

/** Solo per i test: svuota la cache dei valori risolti. */
export function resetCssVarCache(): void {
  cache.clear()
}
