/**
 * Nome di tipo CI → tipo GraphQL / label Neo4j. Divide **solo** su `_`, ed è
 * `CI_TYPE_NAME_RE` (`nameValidation.ts`) a renderlo sicuro: senza quella
 * regola un nome con spazi o trattini passerebbe intatto nell'SDL.
 */
export function toPascalCase(str: string): string {
  return str.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

/**
 * Nome di campo CI → chiave di proprietà Neo4j (`costCenter` → `cost_center`).
 *
 * Definizione unica: `apps/api/src/lib/mappers.ts` la ri-esporta. Vive qui
 * perché `nameValidation.ts` deve sapere su quale proprietà finirebbe un campo
 * prima di accettarlo, e questo pacchetto non può importare `apps/api`.
 */
export function toSnakeCase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

export function pluralize(str: string): string {
  if (str.endsWith('s')) return str + 'es'
  if (str.endsWith('y')) return str.slice(0, -1) + 'ies'
  return str + 's'
}
