/**
 * Shared condition evaluator — used by AutoTriggers and BusinessRules.
 */

export type ConditionOperator =
  | 'equals' | 'not_equals'
  | 'is_null' | 'is_not_null'
  | 'greater_than' | 'less_than'
  | 'contains'

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
    case 'contains':     return typeof actual === 'string' && typeof c.value === 'string' && actual.includes(c.value)
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
