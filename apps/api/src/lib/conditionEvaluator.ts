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

function evalCondition(c: Condition, entity: Record<string, unknown>): boolean {
  const actual = entity[c.field]
  switch (c.operator) {
    case 'equals':       return actual === c.value
    case 'not_equals':   return actual !== c.value
    case 'is_null':      return actual == null || actual === ''
    case 'is_not_null':  return actual != null && actual !== ''
    case 'greater_than': return Number(actual) > Number(c.value)
    case 'less_than':    return Number(actual) < Number(c.value)
    /**
     * «contiene»: dentro un testo, oppure dentro una LISTA (la selezione
     * multipla di un modulo del catalogo, ondata 5). Prima una lista cadeva
     * nel `typeof === 'string'` e la condizione era sempre falsa: una regola
     * che non scattava mai, senza un errore che lo dicesse.
     */
    case 'contains':
      if (Array.isArray(actual)) return actual.some((v) => v === c.value)
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
    throw new Error(`Corrupt conditions JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(arr)) {
    throw new Error(`Conditions payload is not an array (got ${typeof arr})`)
  }
  return arr as Condition[]
}
