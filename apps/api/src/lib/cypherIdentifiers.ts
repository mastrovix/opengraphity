// Single source of truth for identifier validation wherever a user- or
// connector-supplied name would otherwise be interpolated into Cypher.
//
// Rule: anything that ends up as `n.<field>`, `:<Label>` or `[:<REL_TYPE>]`
// must pass one of these regexes BEFORE the query string is assembled.
// Values (not identifiers) always travel as query parameters.

import { ValidationError } from './errors.js'

/** Property / field names: snake_case identifiers only. */
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]*$/

/** Node labels: PascalCase-ish identifiers (Incident, ConfigurationItem, CIBase). */
export const LABEL_RE = /^[A-Z][A-Za-z0-9_]*$/

/** Relationship types: UPPER_SNAKE_CASE identifiers. */
export const REL_TYPE_RE = /^[A-Z][A-Z0-9_]*$/

export const SORT_DIRS = ['ASC', 'DESC'] as const
export type SortDir = typeof SORT_DIRS[number]

/** Property keys that callers must never be able to overwrite through a dynamic SET. */
export const RESERVED_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'tenant_id', 'id', 'created_at', 'labels',
])

function preview(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

/**
 * Throws ValidationError unless `name` is a safe snake_case field identifier.
 * `what` names the offending input in the error message (e.g. "groupByField").
 */
export function assertFieldName(name: unknown, what: string): string {
  if (typeof name !== 'string' || !FIELD_NAME_RE.test(name)) {
    throw new ValidationError(`${what}: invalid field name ${JSON.stringify(preview(name))} (expected ${FIELD_NAME_RE.source})`)
  }
  return name
}

/** Like assertFieldName, but also rejects system-managed keys. */
export function assertWritablePropertyKey(name: unknown, what: string): string {
  const key = assertFieldName(name, what)
  if (RESERVED_PROPERTY_KEYS.has(key)) {
    throw new ValidationError(`${what}: property "${key}" is system-managed and cannot be set`)
  }
  return key
}

export function assertLabel(label: unknown, what: string): string {
  if (typeof label !== 'string' || !LABEL_RE.test(label)) {
    throw new ValidationError(`${what}: invalid Neo4j label ${JSON.stringify(preview(label))}`)
  }
  return label
}

export function assertRelationshipType(relType: unknown, what: string): string {
  if (typeof relType !== 'string' || !REL_TYPE_RE.test(relType)) {
    throw new ValidationError(`${what}: invalid relationship type ${JSON.stringify(preview(relType))}`)
  }
  return relType
}

export function assertSortDir(dir: unknown, what: string): SortDir {
  const upper = typeof dir === 'string' ? dir.toUpperCase() : dir
  if (upper !== 'ASC' && upper !== 'DESC') {
    throw new ValidationError(`${what}: invalid sort direction ${JSON.stringify(preview(dir))} (expected ASC or DESC)`)
  }
  return upper
}
