/**
 * L'ORDINAMENTO CHIESTO DAL CLIENT, o un errore che lo dice (revisione totale ·
 * A-22).
 *
 * Un `sortField` fuori dalla whitelist veniva ignorato in silenzio: la lista
 * tornava ordinata per il campo predefinito, la tabella mostrava la freccia
 * sulla colonna chiesta, e chi chiamava l'API non sapeva che il suo ordine non
 * era stato applicato. Contro la regola «niente fallback silenziosi».
 */
import { ValidationError } from './errors.js'

/**
 * `whitelist[sortField]`, o il default quando il client non chiede niente.
 * Un campo fuori whitelist è rifiutato NOMINANDO quelli ammessi.
 */
export function orderByOrThrow(
  whitelist: Readonly<Record<string, string>>,
  sortField: string | null | undefined,
  sortDirection: string | null | undefined,
  defaultOrderBy: string,
  what: string,
): string {
  const dir = sortDirection?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
  if (sortField == null || sortField === '') return defaultOrderBy
  // Own keys only: `whitelist[sortField]` used to resolve inherited members
  // too, so `toString` / `constructor` / `__proto__` passed the check and a
  // function source or "[object Object]" was interpolated into ORDER BY
  // (a Cypher syntax error instead of the validation error that names the
  // sortable fields).
  const col = Object.prototype.hasOwnProperty.call(whitelist, sortField) ? whitelist[sortField] : undefined
  if (typeof col !== 'string' || col === '') {
    throw new ValidationError(
      `${what}: "${sortField}" is not a sortable field. Sortable: ${Object.keys(whitelist).join(', ')}.`,
      { key: 'errors.sort.unknownField', params: { what, field: sortField, allowed: Object.keys(whitelist).join(', ') } },
    )
  }
  return `${col} ${dir}`
}

/** The prefix of a customer's field in `sortField` (the web's column key: `cf:<name>`). */
export const CUSTOM_FIELD_SORT_PREFIX = 'cf:'

/**
 * A CUSTOMER'S FIELD IS SORTABLE TOO (26 Sep 2026, the owner: «le colonne
 * dovrebbero essere sempre tutte ordinabili»).
 *
 * The fields a customer adds to a ticket are properties of the ticket node,
 * named by the field. The name travels as a parameter (`$sortCustomField`),
 * never in the query text, and only a field the customer defined is accepted.
 * Returns null when `sortField` is not a customer's field.
 */
export function customFieldOrderBy(
  alias: string,
  sortField: string | null | undefined,
  sortDirection: string | null | undefined,
  params: Record<string, unknown>,
  customFieldNames: readonly string[],
  what: string,
): string | null {
  if (!sortField?.startsWith(CUSTOM_FIELD_SORT_PREFIX)) return null
  const name = sortField.slice(CUSTOM_FIELD_SORT_PREFIX.length)
  if (!customFieldNames.includes(name)) {
    throw new ValidationError(
      `${what}: "${sortField}" is not a field of this ticket type. Custom fields: ${customFieldNames.join(', ') || 'none'}.`,
      { key: 'errors.sort.unknownField', params: { what, field: sortField, allowed: customFieldNames.join(', ') } },
    )
  }
  params['sortCustomField'] = name
  const dir = sortDirection?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
  return `${alias}[$sortCustomField] ${dir}`
}

/**
 * The SLA of a ticket as ONE sort key, most urgent first: breached, then
 * running by its resolution deadline, then met, then no SLA at all. The
 * ticket's latest SLA status is the one that counts (a restarted SLA leaves
 * the older ones behind). `alias` is the ticket's variable in the query.
 */
export function slaOrderExpr(alias: string): string {
  const latest = `reduce(best = null, s IN [(${alias})-[:HAS_SLA]->(x:SLAStatus) | x] | CASE WHEN best IS NULL OR s.started_at > best.started_at THEN s ELSE best END)`
  return `CASE WHEN ${latest} IS NULL THEN '3' WHEN ${latest}.breached THEN '0' WHEN ${latest}.resolve_met THEN '2' ELSE '1' + coalesce(${latest}.resolve_deadline, '') END`
}
