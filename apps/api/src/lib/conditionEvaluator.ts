/**
 * Shared condition evaluator — used by AutoTriggers and BusinessRules.
 */

export type ConditionOperator =
  | 'equals' | 'not_equals'
  | 'is_null' | 'is_not_null'
  | 'greater_than' | 'less_than'
  | 'contains'
  /** Il campo è fra quelli cambiati dall'aggiornamento (solo «aggiornato» / «campo cambiato»: V-19). */
  | 'changed'

/**
 * Dove il motore mette i campi cambiati da un aggiornamento, accanto ai valori
 * del ticket. Secondo giro UI del 15 set 2026 · V-19: una regola «aggiornato» con
 * «Urgenza = alta» scattava a OGNI modifica del ticket finché l'urgenza restava
 * alta; con «Urgenza è cambiato» scatta solo quando cambia davvero.
 */
export const CHANGED_FIELDS_KEY = '__changedFields'

/** Le condizioni che usano «è cambiato» (hanno senso solo sugli eventi di aggiornamento). */
export function usesChangedOperator(conditions: readonly Condition[]): boolean {
  return conditions.some((c) => c.operator === 'changed')
}

export interface Condition {
  field:    string
  operator: ConditionOperator
  value?:   unknown
}

/**
 * DUE VALORI SONO LO STESSO VALORE? (revisione del 17 set 2026)
 *
 * La condizione arriva dall'interfaccia, e l'interfaccia salva sempre una
 * STRINGA: la tendina di una regola scrive `"true"`, `"1200"`, `"2026-03-01"`.
 * Il ticket invece porta il valore col suo tipo — un modulo del catalogo
 * scrive un booleano vero e un numero vero (`coerce` in lib/catalogForm.ts) —
 * e `true === "true"` è falso.
 *
 * Il risultato era una regola che restava «attiva» e non partiva MAI, senza un
 * errore e senza una riga di log: il difetto peggiore di questa famiglia,
 * perché `maggiore di` funzionava (passa da `Number()`) e l'amministratore
 * vedeva che «qualcosa funziona». Trovato dalla revisione a tappeto del 17 set
 * 2026, ed è lo stesso difetto già pagato due volte: l'`equals` su una lista e
 * il `contains` sui multi-valore.
 *
 * La regola: si confronta per TIPO del valore che sta sul ticket, non per
 * forma. Booleano contro `"true"`/`"false"`, numero contro il numero scritto,
 * e per tutto il resto il confronto stretto di prima — che per due stringhe è
 * esattamente quello che era.
 */
export function sameValue(actual: unknown, wanted: unknown): boolean {
  if (actual === wanted) return true
  if (actual == null || wanted == null) return false
  if (typeof actual === 'boolean') {
    const testo = String(wanted).trim().toLowerCase()
    return testo === (actual ? 'true' : 'false')
  }
  if (typeof actual === 'number') {
    const n = Number(String(wanted).trim())
    return Number.isFinite(n) && n === actual
  }
  // Una LISTA (selezione multipla) non è «uguale» a un valore singolo:
  // l'appartenenza si chiede con «contiene», che è un operatore suo.
  return false
}

/** A date the rule editor writes (`2026-10-01`) or the graph holds (ISO): the instant, or null. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/
function instantOf(v: unknown): number | null {
  if (typeof v !== 'string' || !ISO_DATE.test(v.trim())) return null
  const t = Date.parse(v.trim())
  return Number.isNaN(t) ? null : t
}

/**
 * «Greater than» / «less than» — and «after» / «before» on a date field
 * (review of 23 Sep 2026). Dates were compared with `Number()`, and
 * `Number('2026-10-01')` is NaN: a rule «due date after 1 October» stayed
 * enabled and never fired. Two dates compare as instants; anything else as
 * numbers. An EMPTY field is neither greater nor less than anything — it
 * counted as 0, so «cost less than 5» was true on every ticket without a cost.
 */
function compares(actual: unknown, wanted: unknown, sign: 1 | -1): boolean {
  if (actual == null || actual === '' || wanted == null || wanted === '') return false
  const a = instantOf(actual)
  const b = instantOf(wanted)
  if (a !== null && b !== null) return sign > 0 ? a > b : a < b
  const x = Number(actual)
  const y = Number(wanted)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return sign > 0 ? x > y : x < y
}

function evalCondition(c: Condition, entity: Record<string, unknown>): boolean {
  const actual = entity[c.field]
  switch (c.operator) {
    case 'equals':       return sameValue(actual, c.value)
    case 'not_equals':   return !sameValue(actual, c.value)
    case 'is_null':      return actual == null || actual === ''
    case 'is_not_null':  return actual != null && actual !== ''
    case 'greater_than': return compares(actual, c.value, 1)
    case 'less_than':    return compares(actual, c.value, -1)
    /**
     * «contiene»: dentro un testo, oppure dentro una LISTA (la selezione
     * multipla di un modulo del catalogo, ondata 5). Prima una lista cadeva
     * nel `typeof === 'string'` e la condizione era sempre falsa: una regola
     * che non scattava mai, senza un errore che lo dicesse.
     */
    case 'contains':
      // In una lista si cerca l'APPARTENENZA, con lo stesso confronto per tipo
      // di `equals`: una lista di numeri contro il «1200» della tendina.
      if (Array.isArray(actual)) return actual.some((v) => sameValue(v, c.value))
      return typeof actual === 'string' && typeof c.value === 'string' && actual.includes(c.value)
    case 'changed': {
      const changed = entity[CHANGED_FIELDS_KEY]
      return Array.isArray(changed) && changed.includes(c.field)
    }
    default:
      // Unknown operator = corrupt/hand-edited config. Fail loud: silently
      // treating it as false (or true) inverts the rule's semantics.
      throw new Error(`Unknown condition operator: ${String(c.operator)} (field: ${c.field})`)
  }
}

/**
 * Evaluates an array of conditions against an entity.
 * @param logic 'and' = all must be true, 'or' = at least one must be true
 */
export function evaluateConditions(
  conditions: Condition[],
  entity: Record<string, unknown>,
  logic: 'and' | 'or' = 'and',
): boolean {
  if (conditions.length === 0) return true
  const results = conditions.map(c => evalCondition(c, entity))
  return logic === 'and' ? results.every(Boolean) : results.some(Boolean)
}

/**
 * Parses a JSON string of conditions.
 *
 * Throws on malformed JSON or a non-array payload: an empty result here means
 * "no conditions" which evaluateConditions treats as "always matches" — so
 * silently swallowing corrupt data would make the rule fire unconditionally,
 * inverting its semantics. Callers must skip the rule and surface the error.
 */
export function parseConditions(raw: string | null | undefined): Condition[] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Corrupt conditions JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
  if (!Array.isArray(arr)) {
    throw new Error(`Conditions payload is not an array (got ${typeof arr})`)
  }
  return arr as Condition[]
}
