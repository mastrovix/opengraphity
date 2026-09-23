/**
 * Lo stile di un valore di dominio quando il cliente può averne aggiunti
 * (ondata 7 · D-15).
 *
 * ## Il difetto
 * Le palette per valore (`SEVERITY_STYLE`, `CI_STATUS_STYLE`, gli stati del
 * problem, lo stato del ticket nel portale) trattavano **qualunque** valore non
 * mappato come un errore: `lookupOrError` restituiva la pastiglia **rossa
 * piena con testo bianco** e scriveva `console.error` a ogni riga di lista.
 * Ma i vocabolari sono del cliente — è la decisione di quest'ondata — e
 * `blocker` aggiunto a `severity` è una configurazione legittima, non un
 * difetto. La regola «niente fallback silenziosi» era applicata al caso
 * sbagliato: faceva sembrare rotta la personalizzazione.
 *
 * ## La regola, adesso
 * Due casi, che prima erano confusi in uno:
 *
 *  1. **il valore è nel vocabolario del cliente, ma nessuno gli ha assegnato
 *     uno stile** → è *normale*. Stile neutro, etichetta leggibile
 *     (`humanizeValue`), nessun rumore in console.
 *  2. **il valore NON è nel vocabolario del cliente** → è un errore vero (un
 *     record rimasto su un valore che il Dizionario non ha più, o una
 *     scrittura che ha scavalcato la validazione). Resta rosso, e `console.error`
 *     — è la stessa cosa che il form del CI segnala come «non più nel
 *     vocabolario».
 *
 * Revisione del 14 set 2026 · F9: lo stile di un valore non è più una tabella
 * del web (`SEVERITY_STYLE`, `CI_STATUS_STYLE`, `PRIORITY_COLOR`…): è il COLORE
 * che il cliente assegna al valore nel Dizionario, accanto all'etichetta, scelto
 * dalla palette chiusa `VALUE_COLORS`. «Senza stile» vuol dire «nessun colore
 * scelto».
 *
 * Il terzo caso esiste e va detto: **il vocabolario non è (ancora) noto** —
 * la query non è tornata, o quella palette non ne ha uno da consultare.
 * Allora non si può distinguere fra 1 e 2: si sceglie il neutro, perché
 * accusare di essere rotto un valore che non si è potuto verificare è il
 * difetto di prima. La differenza si vede in console: `console.warn` invece di
 * `console.error`.
 */
import type { ValueColor } from '@opengraphity/types'
import { colors, palette } from '@/lib/tokens'

/** Sfondo e testo della pastiglia; `accent` per pallini e bordi. */
export interface ValueStyle { bg: string; color: string; accent: string }

/** Valore del vocabolario senza un colore assegnato: normale, quindi neutro. */
export const NEUTRAL_VALUE_STYLE: ValueStyle = { bg: colors.slateBg, color: 'var(--color-slate)', accent: 'var(--color-slate-light)' }

/** Valore FUORI dal vocabolario del cliente: un errore, e si vede. */
export const BROKEN_VALUE_STYLE: ValueStyle = { bg: 'var(--color-danger)', color: colors.white, accent: 'var(--color-danger)' }

/** Lo stile di una famiglia della palette, per nome (il colore del Dizionario). */
export function valueColorStyle(color: ValueColor): ValueStyle {
  if (color === 'neutral') return NEUTRAL_VALUE_STYLE
  const family = palette[color]
  return { bg: family.tint, color: family.text, accent: family.base }
}

/**
 * Lo stile di un valore di vocabolario.
 *
 * `vocabulary` = il nome del vocabolario (compare nei messaggi di console);
 * `values` = i valori ammessi per questo cliente, oppure `null` quando non si
 * conoscono; `color` = il colore che il Dizionario assegna al valore, o `null`.
 */
export function vocabularyValueStyle(
  vocabulary: string,
  value: string,
  values: readonly string[] | null,
  color: ValueColor | null,
): ValueStyle {
  if (color) return valueColorStyle(color)
  if (values === null) {
    console.warn(`[${vocabulary}] "${value}" has no color and the vocabulary of this tenant is unavailable: neutral style`)
    return NEUTRAL_VALUE_STYLE
  }
  if (values.includes(value)) return NEUTRAL_VALUE_STYLE
  console.error(`[${vocabulary}] "${value}" is not in the vocabulary of this tenant (${values.join(', ') || 'empty'})`)
  return BROKEN_VALUE_STYLE
}
