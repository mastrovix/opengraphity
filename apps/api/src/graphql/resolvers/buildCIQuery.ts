import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { orderByOrThrow } from '../../lib/sortField.js'

export { buildAdvancedWhere }

// ── Allowed base fields ───────────────────────────────────────────────────────

// Allowed base field keys (camelCase) — validated before use in Cypher
export const ALLOWED_BASE_FIELDS = new Set([
  'name', 'status', 'environment', 'description', 'notes',
  'chain', 'createdAt', 'updatedAt', 'ownerGroup',
])

// `health` (salute dal monitoraggio, Event Management): `is_empty` = CI mai
// toccato da un allarme, il filtro "senza monitoraggio" della pagina Salute CI.
export const ALL_CIS_ALLOWED_FIELDS = new Set(['name', 'status', 'environment', 'createdAt', 'health'])

// ── Sort whitelist ────────────────────────────────────────────────────────────

/**
 * Elenco di UN tipo di CI (`dynamic-ci.ts`, pagina di tipo): la query lega
 * `og` (gruppo proprietario) con un OPTIONAL MATCH, quindi `ownerGroup` si
 * ordina davvero. La colonna era ordinabile nel web e ignorata qui
 * (revisione totale · B-9, stessa famiglia di `number` sugli incident).
 */
export const CI_SORT_WHITELIST: Record<string, string> = {
  name: 'n.name', status: 'n.status', environment: 'n.environment', createdAt: 'n.created_at',
  ownerGroup: 'og.name',
}

/** Il tipo di un CI è la sua label di dominio: non è una proprietà del nodo. */
export const CI_TYPE_ORDER_EXPR = "head([l IN labels(n) WHERE l <> 'ConfigurationItem'])"

/**
 * CMDB (`allCIs`, tutti i tipi insieme): `sortField`/`sortDirection` erano
 * dichiarati nello schema e il resolver NON li leggeva affatto — ogni clic su
 * un'intestazione della CMDB mostrava la freccia e lasciava l'ordine per nome
 * (revisione totale · B-9). Qui `og` non è legato, quindi il gruppo non è
 * ordinabile e la colonna del web non lo dichiara.
 */
export const ALL_CIS_SORT_WHITELIST: Record<string, string> = {
  name: 'n.name', status: 'n.status', environment: 'n.environment', createdAt: 'n.created_at',
  type: CI_TYPE_ORDER_EXPR,
}

export function allCIsOrderBy(sortField?: string | null, sortDirection?: string | null): string {
  return orderByOrThrow(ALL_CIS_SORT_WHITELIST, sortField, sortDirection, 'n.name ASC', 'allCIs(sortField)')
}

// ── ciOrderBy ─────────────────────────────────────────────────────────────────

export function ciOrderBy(sortField?: string, sortDirection?: string): string {
  // A-22: nessun ordine diverso in silenzio.
  return orderByOrThrow(CI_SORT_WHITELIST, sortField, sortDirection, 'n.name ASC', 'sortField')
}

// ── buildBaseWhere ────────────────────────────────────────────────────────────

export function buildBaseWhere(
  filters: string | undefined,
  params: Record<string, unknown>,
  allowedFields: Set<string>,
): string {
  const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'n', {
    ownerGroup: { relType: 'OWNED_BY', targetLabel: 'Team', searchProp: 'name' },
  }) : ''
  const baseWhere = `($status IS NULL OR n.status = $status)
    AND ($environment IS NULL OR n.environment = $environment)
    AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))`
  return advWhere ? `${baseWhere} AND (${advWhere})` : baseWhere
}
