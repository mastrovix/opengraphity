/**
 * Shared condition row editor — used by AutoTriggersPage and BusinessRulesPage.
 * Loads field definitions for the selected entity type, shows appropriate
 * operator options and value input based on field type.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { GET_ITIL_TYPES, GET_CI_TYPES, GET_TEAMS } from '@/graphql/queries'
import { inputS, selectS } from '@/pages/settings/shared/designerStyles'
import { X } from 'lucide-react'

const GET_USERS_COND = gql`query GetUsersCond { users { id name email } }`

// ── Types ────────────────────────────────────────────────────────────────────

export interface Condition {
  field:    string
  operator: string
  value:    string
}

interface FieldMeta {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
}

interface Props {
  condition:  Condition
  entityType: string
  onChange:   (patch: Partial<Condition>) => void
  onRemove:  () => void
}

// ── Constants ────────────────────────────────────────────────────────────────

const ITIL_ENTITIES = new Set(['incident', 'problem', 'change', 'service_request'])

const FIELD_TYPE_LABELS: Record<string, string> = {
  string: 'testo', number: 'numero', date: 'data', boolean: 'booleano', enum: 'enum',
  user: 'utente', team: 'team',
}

const OPERATORS_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  enum: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'is_null', label: 'è nullo' },
    { value: 'is_not_null', label: 'non è nullo' },
  ],
  string: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'contains', label: 'contiene' },
    { value: 'is_null', label: 'è nullo' },
    { value: 'is_not_null', label: 'non è nullo' },
  ],
  number: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'greater_than', label: '>' },
    { value: 'less_than', label: '<' },
    { value: 'is_null', label: 'è nullo' },
    { value: 'is_not_null', label: 'non è nullo' },
  ],
  date: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'greater_than', label: 'dopo' },
    { value: 'less_than', label: 'prima' },
    { value: 'is_null', label: 'è nullo' },
    { value: 'is_not_null', label: 'non è nullo' },
  ],
  boolean: [
    { value: 'equals', label: '=' },
    { value: 'is_null', label: 'è nullo' },
    { value: 'is_not_null', label: 'non è nullo' },
  ],
  user: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'is_null', label: 'è nullo' },
    { value: 'is_not_null', label: 'non è nullo' },
  ],
  team: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'is_null', label: 'è nullo' },
    { value: 'is_not_null', label: 'non è nullo' },
  ],
}

const ALL_OPERATORS = [
  { value: 'equals', label: '=' },
  { value: 'not_equals', label: '≠' },
  { value: 'contains', label: 'contiene' },
  { value: 'greater_than', label: '>' },
  { value: 'less_than', label: '<' },
  { value: 'is_null', label: 'è nullo' },
  { value: 'is_not_null', label: 'non è nullo' },
]

const HIDE_VALUE_OPS = new Set(['is_null', 'is_not_null'])

const removeBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 2,
  display: 'flex', alignItems: 'center',
}

// ── Hook: load fields for entity type ────────────────────────────────────────

interface TypeDef {
  name:   string
  fields: { name: string; label: string; fieldType: string; enumValues?: string[] | null }[]
}

function useEntityFields(entityType: string): FieldMeta[] {
  const isITIL = ITIL_ENTITIES.has(entityType)
  const { data: itilData } = useQuery(GET_ITIL_TYPES, { skip: !isITIL, fetchPolicy: 'cache-first' })
  const { data: ciData }   = useQuery(GET_CI_TYPES,   { skip: isITIL, fetchPolicy: 'cache-first' })

  return useMemo(() => {
    const types = isITIL
      ? (itilData as { itilTypes?: TypeDef[] } | undefined)?.itilTypes
      : (ciData   as { ciTypes?:   TypeDef[] } | undefined)?.ciTypes
    if (!types) return []
    const typeDef = types.find(t => t.name === entityType)
    if (!typeDef) return []
    return typeDef.fields.map(f => ({
      name:       f.name,
      label:      f.label || f.name,
      fieldType:  f.fieldType,
      enumValues: f.enumValues ?? [],
    }))
  }, [isITIL, entityType, itilData, ciData])
}

// ── Component ────────────────────────────────────────────────────────────────

export function ConditionRowEditor({ condition, entityType, onChange, onRemove }: Props) {
  const fields = useEntityFields(entityType)
  const { data: teamsData } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: 'cache-first' })
  const { data: usersData } = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS_COND, { fetchPolicy: 'cache-first' })

  // Add relationship-based virtual fields with proper types
  const allFields: FieldMeta[] = useMemo(() => {
    const extra: FieldMeta[] = []
    if (!fields.find(f => f.name === 'assigned_to')) {
      extra.push({ name: 'assigned_to', label: 'Assegnato a', fieldType: 'user', enumValues: [] })
    }
    if (!fields.find(f => f.name === 'assigned_team')) {
      extra.push({ name: 'assigned_team', label: 'Team assegnato', fieldType: 'team', enumValues: [] })
    }
    return [...fields, ...extra]
  }, [fields])

  const selectedField = allFields.find(f => f.name === condition.field)
  const fieldType     = selectedField?.fieldType ?? 'string'
  const operators     = OPERATORS_BY_TYPE[fieldType] ?? ALL_OPERATORS
  const hideValue     = HIDE_VALUE_OPS.has(condition.operator)

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
      {/* Field dropdown */}
      <select
        style={{ ...selectS, width: 160 }}
        value={condition.field}
        onChange={e => onChange({ field: e.target.value, value: '' })}
      >
        <option value="">-- Campo --</option>
        {allFields.map(f => {
          const typeLabel = FIELD_TYPE_LABELS[f.fieldType] ?? f.fieldType
          return <option key={f.name} value={f.name}>{f.label} ({typeLabel})</option>
        })}
      </select>

      {/* Operator dropdown */}
      <select
        style={{ ...selectS, width: 110 }}
        value={condition.operator}
        onChange={e => onChange({ operator: e.target.value })}
      >
        {operators.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>

      {/* Value input — type-specific, hidden for is_null/is_not_null */}
      {!hideValue && renderValueInput(condition, selectedField, onChange, usersData?.users ?? [], teamsData?.teams ?? [])}

      {/* Remove button */}
      <button style={removeBtn} onClick={onRemove}><X size={14} color="#ef4444" /></button>
    </div>
  )
}

function renderValueInput(
  condition: Condition,
  field: FieldMeta | undefined,
  onChange: (patch: Partial<Condition>) => void,
  users: { id: string; name: string; email: string }[],
  teams: { id: string; name: string }[],
) {
  if (!field) {
    return <input style={{ ...inputS, flex: 1, minWidth: 80 }} placeholder="Valore" value={condition.value} onChange={e => onChange({ value: e.target.value })} />
  }

  // User → dropdown with users
  if (field.fieldType === 'user') {
    return (
      <select style={{ ...selectS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })}>
        <option value="">-- Utente --</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
      </select>
    )
  }

  // Team → dropdown with teams
  if (field.fieldType === 'team') {
    return (
      <select style={{ ...selectS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })}>
        <option value="">-- Team --</option>
        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    )
  }

  // Enum → dropdown
  if (field.fieldType === 'enum' && field.enumValues.length > 0) {
    return (
      <select style={{ ...selectS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })}>
        <option value="">-- Valore --</option>
        {field.enumValues.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  // Boolean → Sì/No dropdown
  if (field.fieldType === 'boolean') {
    return (
      <select style={{ ...selectS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })}>
        <option value="">-- Valore --</option>
        <option value="true">Sì</option>
        <option value="false">No</option>
      </select>
    )
  }

  // Date → date picker
  if (field.fieldType === 'date') {
    return <input type="date" style={{ ...inputS, flex: 1 }} value={condition.value} onChange={e => onChange({ value: e.target.value })} />
  }

  // Number → numeric input
  if (field.fieldType === 'number') {
    return <input type="number" style={{ ...inputS, flex: 1, minWidth: 80 }} placeholder="Valore" value={condition.value} onChange={e => onChange({ value: e.target.value })} />
  }

  // String → text input
  return <input style={{ ...inputS, flex: 1, minWidth: 80 }} placeholder="Valore" value={condition.value} onChange={e => onChange({ value: e.target.value })} />
}
