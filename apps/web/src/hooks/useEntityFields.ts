/**
 * Builds FilterBuilder FieldConfig[] dynamically from GraphQL schema introspection.
 * No hardcoded enum values — status/severity/priority/type are now proper GraphQL
 * enums, so their values come directly from the schema via __type introspection.
 */
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import type { FieldConfig } from '@/components/FilterBuilder'

// ── Introspection query ───────────────────────────────────────────────────────

const INTROSPECT_TYPE = gql`
  query IntrospectType($name: String!) {
    __type(name: $name) {
      fields {
        name
        type {
          kind name
          enumValues { name }
          ofType {
            kind name
            enumValues { name }
            ofType {
              kind name
              enumValues { name }
            }
          }
        }
      }
    }
  }
`

// ── Internal types ────────────────────────────────────────────────────────────

interface TypeRef {
  kind:       string
  name:       string | null
  enumValues: { name: string }[] | null
  ofType:     TypeRef | null
}

interface IntrospectionField {
  name: string
  type: TypeRef
}

// ── Fields to always skip ─────────────────────────────────────────────────────

const SKIP_FIELDS = new Set(['id', 'tenantId', '__typename'])

// ── Date field names that don't end with "At" ─────────────────────────────────

const DATE_FIELD_NAMES = new Set(['dueDate', 'scheduledStart', 'scheduledEnd', 'implementedAt'])

// ── Label: camelCase → "Camel Case" ──────────────────────────────────────────

function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}

// ── Enum value label: "in_progress" → "In Progress" ──────────────────────────

function enumLabel(v: string): string {
  return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Type resolver: unwrap NON_NULL, detect SCALAR/ENUM, skip LIST/OBJECT ──────

type Resolved =
  | { kind: 'scalar'; name: string }
  | { kind: 'enum';   values: string[] }
  | null

function resolveType(t: TypeRef): Resolved {
  let cur = t
  if (cur.kind === 'NON_NULL') {
    if (!cur.ofType) return null
    cur = cur.ofType
  }
  // Any LIST wrapper → skip (list fields are relations or arrays, not filterable scalars)
  if (cur.kind === 'LIST' || cur.kind === 'NON_NULL') return null
  if (cur.kind === 'SCALAR') return { kind: 'scalar', name: cur.name ?? '' }
  if (cur.kind === 'ENUM')   return { kind: 'enum',   values: (cur.enumValues ?? []).map((e) => e.name) }
  return null  // OBJECT, INTERFACE, UNION → skip (relations)
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useEntityFields(typeName: string): FieldConfig[] {
  const { data } = useQuery<{ __type: { fields: IntrospectionField[] } | null }>(
    INTROSPECT_TYPE,
    { variables: { name: typeName }, fetchPolicy: 'cache-first' },
  )

  const rawFields = data?.__type?.fields
  if (!rawFields) return []

  const result: FieldConfig[] = []

  for (const f of rawFields) {
    if (SKIP_FIELDS.has(f.name)) continue

    const resolved = resolveType(f.type)
    if (!resolved) continue  // object / list → skip

    const label = camelToLabel(f.name)

    // GraphQL enum — values and labels come directly from the schema
    if (resolved.kind === 'enum') {
      result.push({
        key:     f.name,
        label,
        type:    'enum',
        options: resolved.values.map((v) => ({ value: v, label: enumLabel(v) })),
      })
      continue
    }

    // Scalar
    const scalarName = resolved.name

    if (scalarName === 'Boolean' || scalarName === 'ID' || scalarName === 'Int' || scalarName === 'Float') continue

    if (f.name.endsWith('At') || DATE_FIELD_NAMES.has(f.name)) {
      result.push({ key: f.name, label, type: 'date' })
      continue
    }

    result.push({ key: f.name, label, type: 'text' })
  }

  return result
}
