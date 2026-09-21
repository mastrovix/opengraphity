/**
 * La palette dei colori per valore del Dizionario (revisione del 14 set 2026 ·
 * F9).
 *
 * Un valore di vocabolario (una priorità, uno stato del CI, una categoria KB)
 * porta un colore scelto dal cliente accanto alla sua etichetta. Il colore è il
 * NOME di una famiglia di token del web (`palette.<nome>` in
 * apps/web/src/lib/tokens.ts), mai un esadecimale: il tema resta unico e
 * accessibile, e nessun colore finisce scritto nel dato.
 *
 * `neutral` è una scelta esplicita («nessun accento»), diversa dall'assenza di
 * colore, che vuol dire «nessuno l'ha scelto».
 */
export const VALUE_COLORS = ['neutral', 'success', 'info', 'purple', 'warning', 'orange', 'danger'] as const

export type ValueColor = typeof VALUE_COLORS[number]

export function isValueColor(v: unknown): v is ValueColor {
  return typeof v === 'string' && (VALUE_COLORS as readonly string[]).includes(v)
}
