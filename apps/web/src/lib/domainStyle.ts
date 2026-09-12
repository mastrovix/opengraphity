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
 *     (`enumLabel`), nessun rumore in console.
 *  2. **il valore NON è nel vocabolario del cliente** → è un errore vero (un
 *     record rimasto su un valore che il Dizionario non ha più, o una
 *     scrittura che ha scavalcato la validazione). Resta rosso, e `console.error`
 *     — è la stessa cosa che il form del CI segnala come «non più nel
 *     vocabolario».
 *
 * Il terzo caso esiste e va detto: **il vocabolario non è (ancora) noto** —
 * la query non è tornata, o quella palette non ne ha uno da consultare.
 * Allora non si può distinguere fra 1 e 2: si sceglie il neutro, perché
 * accusare di essere rotto un valore che non si è potuto verificare è il
 * difetto di prima. La differenza si vede in console: `console.warn` invece di
 * `console.error`.
 */
import { colors } from '@/lib/tokens'

export interface ValueStyle { bg: string; color: string }

/** Valore del vocabolario senza uno stile assegnato: normale, quindi neutro. */
export const NEUTRAL_VALUE_STYLE: ValueStyle = { bg: colors.slateBg, color: 'var(--color-slate)' }

/** Valore FUORI dal vocabolario del cliente: un errore, e si vede. */
export const BROKEN_VALUE_STYLE: ValueStyle = { bg: 'var(--color-danger)', color: colors.white }

/**
 * `vocabulary` = i valori ammessi per questo cliente, oppure `null` quando non
 * si conoscono (query in corso, o palette senza vocabolario da consultare).
 */
export function domainValueStyle<T extends ValueStyle>(
  map: Readonly<Record<string, T>>,
  value: string,
  mapName: string,
  vocabulary: readonly string[] | null,
): T | ValueStyle {
  const hit = map[value]
  if (hit) return hit
  if (vocabulary === null) {
    console.warn(`[${mapName}] "${value}" senza stile e vocabolario del cliente non disponibile: stile neutro`)
    return NEUTRAL_VALUE_STYLE
  }
  if (vocabulary.includes(value)) return NEUTRAL_VALUE_STYLE
  console.error(`[${mapName}] "${value}" non è nel vocabolario di questo cliente (${vocabulary.join(', ') || 'vuoto'})`)
  return BROKEN_VALUE_STYLE
}
