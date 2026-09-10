/**
 * Palette dell'Event Management (badge di stato/severità, chip di
 * correlazione, salute dei CI, banner di tempesta, contatori): tutti i colori
 * risolvono ai token `--color-*` di index.css (compresi `--color-flapping*`
 * per il viola dello sfarfallio), così un cambio di palette o un tema scuro
 * si applicano da soli. Nessun esadecimale qui.
 *
 * Testo dei badge: le tinte `--color-severity-*-text` sono le più scure della
 * scala (≥ 4.5:1 sugli sfondi `--color-*-bg`), scelte per i badge in maiuscolo a 11 px.
 */
const v = (name: string) => `var(${name})`

export interface Tint { bg: string; color: string }

/** Rosso: critico, CI giù. */
export const TINT_CRITICAL: Tint = { bg: v('--color-danger-bg'),  color: v('--color-severity-critical-text') }
/** Ambra: avviso, CI degradato, tempesta, "collega un CI". */
export const TINT_WARNING:  Tint = { bg: v('--color-warning-bg'), color: v('--color-severity-medium-text') }
/** Blu: info, "in attesa". */
export const TINT_INFO:     Tint = { bg: v('--color-info-bg'),    color: v('--color-brand-hover') }
/** Verde: risolto, CI operativo. */
export const TINT_SUCCESS:  Tint = { bg: v('--color-success-bg'), color: v('--color-severity-low-text') }
/** Grigio: silenziato, nessun CI, stato del ciclo di vita. Testo scuro: lo slate medio su slate-bg resta sotto 4.5:1. */
export const TINT_NEUTRAL:  Tint = { bg: v('--color-slate-bg'),   color: v('--color-slate-dark') }
/** Viola: instabile (sfarfallio). Vedi nota in testa sul token mancante. */
export const TINT_FLAPPING: Tint = { bg: v('--color-flapping-bg'), color: v('--color-flapping') }
/** Errore di vocabolario (lookupOrError): rosso pieno, mai un colore "plausibile". */
export const TINT_BROKEN:   Tint = { bg: v('--color-danger'),     color: v('--color-white') }

/** Banner ambra (tempesta, nessuna sorgente): stessa famiglia dei badge di avviso. */
export const AMBER_BANNER = { bg: v('--color-warning-bg'), border: v('--color-severity-medium-border'), text: v('--color-severity-medium-text') } as const

/** Colore pieno per accenti (contatori, strisce di riga): il testo delle tinte è già la tonalità più scura. */
export const ACCENT = {
  danger:   v('--color-danger'),
  critical: TINT_CRITICAL.color,
  warning:  TINT_WARNING.color,
  success:  TINT_SUCCESS.color,
  flapping: TINT_FLAPPING.color,
  neutral:  v('--color-slate'),
  muted:    v('--color-slate-light'),
} as const
