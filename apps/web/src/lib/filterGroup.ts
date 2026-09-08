/**
 * Client-side evaluation of a FilterBuilder group, for lists whose query has
 * no `filters` argument (E-02). Semantics mirror the API's
 * `buildAdvancedWhere` (apps/api/src/lib/filterBuilder.ts): text operators are
 * case-insensitive, date operators compare instants, `rule.logic` is the
 * connector with the NEXT rule (OR chains grouped, AND between groups).
 *
 * Unknown operators throw: a rule silently dropped would widen the result set
 * behind the user's back.
 */
import type { FilterGroup, FilterRule } from '@/components/FilterBuilder'

const DAY_MS = 24 * 60 * 60 * 1000

function asText(v: unknown): string {
  return v == null ? '' : String(v)
}

function asDate(v: unknown): Date | null {
  if (v == null || v === '') return null
  const d = new Date(v as string | number | Date)
  return Number.isNaN(d.getTime()) ? null : d
}

function isEmpty(v: unknown): boolean {
  return v == null || v === ''
}

function ruleMatches(row: Record<string, unknown>, rule: FilterRule): boolean {
  const v   = row[rule.field]
  const val = typeof rule.value === 'string' ? rule.value : ''
  const now = Date.now()

  switch (rule.operator) {
    case 'contains':     return asText(v).toLowerCase().includes(val.toLowerCase())
    case 'starts_with':  return asText(v).toLowerCase().startsWith(val.toLowerCase())
    case 'ends_with':    return asText(v).toLowerCase().endsWith(val.toLowerCase())
    case 'equals':       return asText(v) === val
    case 'not_equals':   return asText(v) !== val
    case 'is_empty':     return isEmpty(v)
    case 'is_not_empty': return !isEmpty(v)
    case 'after': {
      const d = asDate(v); const b = asDate(val)
      return d !== null && b !== null && d.getTime() > b.getTime()
    }
    case 'before': {
      const d = asDate(v); const b = asDate(val)
      return d !== null && b !== null && d.getTime() < b.getTime()
    }
    case 'between': {
      const d = asDate(v); const a = asDate(val); const b = asDate(rule.value2)
      return d !== null && a !== null && b !== null && d.getTime() >= a.getTime() && d.getTime() <= b.getTime()
    }
    case 'today': {
      const d = asDate(v)
      if (d === null) return false
      const t = new Date()
      return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()
    }
    case 'last_7_days': {
      const d = asDate(v)
      return d !== null && d.getTime() > now - 7 * DAY_MS
    }
    case 'last_30_days': {
      const d = asDate(v)
      return d !== null && d.getTime() > now - 30 * DAY_MS
    }
    case 'in':     return Array.isArray(rule.value) && rule.value.includes(asText(v))
    case 'not_in': return !(Array.isArray(rule.value) && rule.value.includes(asText(v)))
    default:
      throw new Error(`Unknown filter operator: ${JSON.stringify(rule.operator)}`)
  }
}

/** True when `row` satisfies the whole group (same AND/OR grouping as the API). */
export function matchesFilterGroup<T extends object>(row: T, group: FilterGroup | null | undefined): boolean {
  const rules = group?.rules ?? []
  if (rules.length === 0) return true

  const r = row as Record<string, unknown>
  let andAcc = true
  let orAcc  = false
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    orAcc = orAcc || ruleMatches(r, rule)
    const isLast = i === rules.length - 1
    if (isLast || rule.logic === 'AND') {
      andAcc = andAcc && orAcc
      orAcc  = false
    }
  }
  return andAcc
}

/** Rows of `rows` that satisfy `group`; the same array when there is no filter. */
export function applyFilterGroup<T extends object>(rows: T[], group: FilterGroup | null | undefined): T[] {
  if (!group?.rules.length) return rows
  return rows.filter((row) => matchesFilterGroup(row, group))
}
