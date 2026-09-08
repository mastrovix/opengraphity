/**
 * Campi di un'entità, in due forme:
 *
 *  - `useEntityFields(typeName)`: FieldConfig[] per FilterBuilder, da
 *    query `entityFilterFields` (scalari/enum dallo schema, senza introspezione).
 *  - `useEntityFieldMetas(entityType)`: FieldMeta[] dal METAMODELLO
 *    (GET_ITIL_TYPES / GET_CI_TYPES) per gli editor di automazione. Prima
 *    esisteva in tre varianti quasi identiche (ConditionRowEditor,
 *    ActionParamsEditor, AutomationPreview).
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import type { FieldConfig } from '@/components/FilterBuilder'
import { GET_ITIL_TYPES, GET_CI_TYPES, GET_ENTITY_FILTER_FIELDS } from '@/graphql/queries'
import { isITILEntity } from '@/lib/automationOperators'

// ── Metamodel field metas (automazione) ──────────────────────────────────────

export interface FieldMeta {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
}

interface TypeDef {
  name:   string
  fields: { name: string; label: string; fieldType: string; enumValues?: string[] | null }[]
}

/** Campi "virtuali" di relazione, offerti oltre a quelli del tipo. */
const VIRTUAL_RELATION_FIELDS: FieldMeta[] = [
  { name: 'assigned_to',   label: 'Assegnato a',    fieldType: 'user', enumValues: [] },
  { name: 'assigned_team', label: 'Team assegnato', fieldType: 'team', enumValues: [] },
]

/**
 * Campi del tipo `entityType` (ITIL o CI) dal metamodello. `withVirtual`
 * aggiunge assigned_to/assigned_team se il tipo non li dichiara già.
 * Tipo non trovato → lista vuota + `error` (non un silenzio).
 */
export function useEntityFieldMetas(entityType: string, { withVirtual = true }: { withVirtual?: boolean } = {}): { fields: FieldMeta[]; error: string | null } {
  const isITIL = isITILEntity(entityType)
  const { data: itilData, error: itilErr } = useQuery(GET_ITIL_TYPES, { skip: !isITIL || !entityType, fetchPolicy: 'cache-first' })
  const { data: ciData,   error: ciErr   } = useQuery(GET_CI_TYPES,   { skip: isITIL  || !entityType, fetchPolicy: 'cache-first' })

  return useMemo(() => {
    if (!entityType) return { fields: [], error: null }
    const qErr = (isITIL ? itilErr : ciErr)
    if (qErr) return { fields: [], error: qErr.message }
    const types = isITIL
      ? (itilData as { itilTypes?: TypeDef[] } | undefined)?.itilTypes
      : (ciData   as { ciTypes?:   TypeDef[] } | undefined)?.ciTypes
    if (!types) return { fields: [], error: null }   // in caricamento
    const typeDef = types.find(t => t.name === entityType)
    if (!typeDef) return { fields: [], error: `tipo "${entityType}" non presente nel metamodello` }
    const fields: FieldMeta[] = typeDef.fields.map(f => ({
      name: f.name, label: f.label || f.name, fieldType: f.fieldType, enumValues: f.enumValues ?? [],
    }))
    if (withVirtual) {
      for (const v of VIRTUAL_RELATION_FIELDS) {
        if (!fields.find(f => f.name === v.name)) fields.push(v)
      }
    }
    return { fields, error: null }
  }, [isITIL, entityType, itilData, ciData, itilErr, ciErr, withVirtual])
}

/** Stessi campi, indicizzati per nome (anteprime/lookup). */
export function useEntityFieldLookup(entityType: string): Map<string, FieldMeta> {
  const { fields } = useEntityFieldMetas(entityType)
  return useMemo(() => new Map(fields.map(f => [f.name, f])), [fields])
}

// ── Campi filtrabili dal server (FilterBuilder) ──────────────────────────────
// Prima si usava l'introspezione `__type`, che in produzione è disattivata:
// ora l'API espone `entityFilterFields` (solo scalari ed enum, già "unwrappati").

interface EntityFilterField {
  name:       string
  kind:       'SCALAR' | 'ENUM'
  scalarName: string | null
  enumValues: string[] | null
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

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useEntityFields(typeName: string): { fields: FieldConfig[]; error: Error | null } {
  const { data, error } = useQuery<{ entityFilterFields: EntityFilterField[] }>(
    GET_ENTITY_FILTER_FIELDS,
    { variables: { typeName }, fetchPolicy: 'cache-first' },
  )

  const rawFields = data?.entityFilterFields
  if (!rawFields) return { fields: [], error: error ?? null }

  const result: FieldConfig[] = []

  for (const f of rawFields) {
    if (SKIP_FIELDS.has(f.name)) continue

    const label = camelToLabel(f.name)

    // GraphQL enum — values and labels come directly from the schema
    if (f.kind === 'ENUM') {
      result.push({
        key:     f.name,
        label,
        type:    'enum',
        options: (f.enumValues ?? []).map((v) => ({ value: v, label: enumLabel(v) })),
      })
      continue
    }

    // Scalar
    const scalarName = f.scalarName ?? ''

    if (scalarName === 'Boolean' || scalarName === 'ID' || scalarName === 'Int' || scalarName === 'Float') continue

    if (f.name.endsWith('At') || DATE_FIELD_NAMES.has(f.name)) {
      result.push({ key: f.name, label, type: 'date' })
      continue
    }

    result.push({ key: f.name, label, type: 'text' })
  }

  return { fields: result, error: error ?? null }
}
