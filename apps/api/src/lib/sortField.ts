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
