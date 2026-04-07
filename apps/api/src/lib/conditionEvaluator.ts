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
    default:             return false
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
 * Parses a JSON string of conditions, returns empty array on failure.
 */
export function parseConditions(raw: string | null | undefined): Condition[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
