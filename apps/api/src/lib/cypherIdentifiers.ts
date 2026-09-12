// Single source of truth for identifier validation wherever a user- or
// connector-supplied name would otherwise be interpolated into Cypher.
//
// Rule: anything that ends up as `n.<field>`, `:<Label>` or `[:<REL_TYPE>]`
// must pass one of these regexes BEFORE the query string is assembled.
// Values (not identifiers) always travel as query parameters.

import { ValidationError } from './errors.js'
import {
  RESERVED_CI_PROPERTY_KEYS as CI_KEYS,
  RESERVED_CI_PROPERTY_PREFIXES as CI_PREFIXES,
} from '@opengraphity/schema-generator'

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

/**
 * Le proprietà di un CI che il prodotto gestisce da sé (A-12). Sovrainsieme di
 * `RESERVED_PROPERTY_KEYS`: oltre alle chiavi di sistema di qualunque nodo ci
 * sono quelle della CMDB (`name_key`, la salute di Event Management, `chain`,
 * `type`) e tutto ciò che comincia per `discovery_`.
 *
 * **Definita in `@opengraphity/schema-generator/nameValidation.ts`** e qui
 * soltanto ri-esportata: la validazione dei nomi del metamodello deve poterla
 * leggere, e quel pacchetto non può importare `apps/api`. Un test
 * (`cypherIdentifiers.test.ts`) pinna che contenga tutta
 * `RESERVED_PROPERTY_KEYS`, così le due non possono divergere.
 */
export const RESERVED_CI_PROPERTY_KEYS = CI_KEYS
export const RESERVED_CI_PROPERTY_PREFIXES = CI_PREFIXES

/**
 * La chiave di proprietà che una scrittura di CI sta per impostare partendo da
 * un campo del metamodello.
 *
 * È la rete sotto la porta di `createCIType`/`addCIField`: la scrittura di un
 * CI (`ciMutations.ts`) copia i campi del metamodello **dopo** aver impostato
 * `tenant_id`, `id` e `name_key`, quindi un campo chiamato `tenantId` — se
 * fosse mai entrato nel metamodello per altre vie — farebbe nascere il CI nel
 * cliente scelto da chi chiama l'API. Qui non si può riparare niente: si
 * rifiuta nominando il campo.
 */
export function assertWritableCIPropertyKey(key: string, fieldName: string): string {
  const prefix = RESERVED_CI_PROPERTY_PREFIXES.find((p) => key.startsWith(p))
  if (RESERVED_CI_PROPERTY_KEYS.has(key) || prefix) {
    throw new ValidationError(
      `Il campo "${fieldName}" del metamodello scriverebbe la proprietà "${key}", che è gestita dal prodotto` +
      (prefix ? ` (prefisso riservato "${prefix}")` : '') +
      `: la scrittura è rifiutata. Rinomina il campo nel disegnatore dei tipi CI.`,
    )
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
