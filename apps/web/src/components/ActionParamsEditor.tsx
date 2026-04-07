/**
 * Renders type-specific param inputs for AutoTrigger and BusinessRule actions.
 * Each action type gets the appropriate control (dropdown, textarea, etc.).
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_TEAMS, GET_WORKFLOW_LIST, GET_ITIL_TYPES, GET_CI_TYPES } from '@/graphql/queries'
import { useEnumValues } from '@/hooks/useEnumValues'
import { inputS, selectS } from '@/pages/settings/shared/designerStyles'
import { gql } from '@apollo/client'

const GET_USERS = gql`query GetUsers { users { id name email } }`

interface Props {
  actionType: string
  params:     Record<string, string>
  entityType: string
  onChange:   (key: string, value: string) => void
}

interface FieldMeta {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
}

const textareaS: React.CSSProperties = { ...inputS, minHeight: 60, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }
const monoS: React.CSSProperties     = { ...inputS, minHeight: 80, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }

const ITIL_ENTITIES = new Set(['incident', 'problem', 'change', 'service_request'])
const FIELD_TYPE_LABELS: Record<string, string> = {
  string: 'testo', number: 'numero', date: 'data', boolean: 'booleano', enum: 'enum',
  user: 'utente', team: 'team',
}

function useEntityFieldMetas(entityType: string): FieldMeta[] {
  const isITIL = ITIL_ENTITIES.has(entityType)
  const { data: itilData } = useQuery(GET_ITIL_TYPES, { skip: !isITIL, fetchPolicy: 'cache-first' })
  const { data: ciData }   = useQuery(GET_CI_TYPES,   { skip: isITIL, fetchPolicy: 'cache-first' })

  return useMemo(() => {
    type TypeDef = { name: string; fields: { name: string; label: string; fieldType: string; enumValues?: string[] | null }[] }
    const types = isITIL
      ? (itilData as { itilTypes?: TypeDef[] } | undefined)?.itilTypes
      : (ciData   as { ciTypes?:   TypeDef[] } | undefined)?.ciTypes
    if (!types) return []
    const typeDef = types.find(t => t.name === entityType)
    if (!typeDef) return []
    const fields: FieldMeta[] = typeDef.fields.map(f => ({
      name: f.name, label: f.label || f.name, fieldType: f.fieldType, enumValues: f.enumValues ?? [],
    }))
    // Add virtual relationship fields
    if (!fields.find(f => f.name === 'assigned_to'))   fields.push({ name: 'assigned_to',   label: 'Assegnato a',     fieldType: 'user', enumValues: [] })
    if (!fields.find(f => f.name === 'assigned_team')) fields.push({ name: 'assigned_team', label: 'Team assegnato', fieldType: 'team', enumValues: [] })
    return fields
  }, [isITIL, entityType, itilData, ciData])
}

export function ActionParamsEditor({ actionType, params, entityType, onChange }: Props) {
  const { data: teamsData }    = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: 'cache-first' })
  const { data: usersData }    = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS, { fetchPolicy: 'cache-first' })
  const { data: workflowData } = useQuery<{ workflowDefinitions: { id: string; name: string; entityType: string; steps: { name: string; label: string }[] }[] }>(GET_WORKFLOW_LIST, { fetchPolicy: 'cache-first' })
  const { values: priorityValues } = useEnumValues(entityType || 'incident', 'priority')
  const { values: severityValues } = useEnumValues(entityType || 'incident', 'severity')
  const fieldMetas = useEntityFieldMetas(entityType)

  const teams = teamsData?.teams ?? []
  const users = usersData?.users ?? []
  const steps = (workflowData?.workflowDefinitions ?? [])
    .filter(w => w.entityType === entityType)
    .flatMap(w => w.steps ?? [])
    .filter((s, i, arr) => arr.findIndex(x => x.name === s.name) === i)

  const selectedFieldMeta = fieldMetas.find(f => f.name === params['field'])

  switch (actionType) {
    case 'assign_team':
      return (
        <select style={{ ...selectS, flex: 1 }} value={params['team_id'] ?? ''} onChange={e => onChange('team_id', e.target.value)}>
          <option value="">-- Seleziona team --</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )

    case 'assign_user':
      return (
        <select style={{ ...selectS, flex: 1 }} value={params['user_id'] ?? ''} onChange={e => onChange('user_id', e.target.value)}>
          <option value="">-- Seleziona utente --</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
        </select>
      )

    case 'transition_workflow':
      return (
        <select style={{ ...selectS, flex: 1 }} value={params['to_step'] ?? ''} onChange={e => onChange('to_step', e.target.value)}>
          <option value="">-- Seleziona step --</option>
          {steps.map(s => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
        </select>
      )

    case 'set_priority':
      return (
        <select style={{ ...selectS, flex: 1 }} value={params['priority'] ?? ''} onChange={e => onChange('priority', e.target.value)}>
          <option value="">-- Seleziona priorità --</option>
          {(priorityValues.length > 0 ? priorityValues : severityValues).map(v =>
            <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
          )}
        </select>
      )

    case 'set_field':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {/* Field dropdown */}
          <select
            style={{ ...selectS, width: 160 }}
            value={params['field'] ?? ''}
            onChange={e => { onChange('field', e.target.value); onChange('value', '') }}
          >
            <option value="">-- Campo --</option>
            {fieldMetas.map(f => (
              <option key={f.name} value={f.name}>{f.label} ({FIELD_TYPE_LABELS[f.fieldType] ?? f.fieldType})</option>
            ))}
          </select>
          {/* Value input — adapts to field type */}
          {renderFieldValue(params['value'] ?? '', v => onChange('value', v), selectedFieldMeta, users, teams)}
        </div>
      )

    case 'create_notification':
      return (
        <textarea style={{ ...textareaS, flex: 1 }} placeholder="Messaggio della notifica..." value={params['message'] ?? ''} onChange={e => onChange('message', e.target.value)} />
      )

    case 'create_comment':
      return (
        <textarea style={{ ...textareaS, flex: 1 }} placeholder="Testo del commento..." value={params['text'] ?? ''} onChange={e => onChange('text', e.target.value)} />
      )

    case 'execute_script':
      return (
        <textarea style={{ ...monoS, flex: 1 }} placeholder="// JavaScript (isolated-vm, timeout 5s)..." value={params['code'] ?? ''} onChange={e => onChange('code', e.target.value)} />
      )

    case 'call_webhook':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          <select style={{ ...selectS, width: 90 }} value={params['method'] ?? 'POST'} onChange={e => onChange('method', e.target.value)}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="GET">GET</option>
          </select>
          <input style={{ ...inputS, flex: 1, minWidth: 200 }} placeholder="https://..." value={params['url'] ?? ''} onChange={e => onChange('url', e.target.value)} />
        </div>
      )

    case 'set_sla':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1 }}>
          <input style={{ ...inputS, width: 100 }} type="number" placeholder="Risposta (min)" value={params['response_minutes'] ?? ''} onChange={e => onChange('response_minutes', e.target.value)} />
          <input style={{ ...inputS, width: 100 }} type="number" placeholder="Risoluzione (min)" value={params['resolve_minutes'] ?? ''} onChange={e => onChange('resolve_minutes', e.target.value)} />
        </div>
      )

    default:
      return <input style={{ ...inputS, flex: 1 }} placeholder="Parametri..." value={params['value'] ?? ''} onChange={e => onChange('value', e.target.value)} />
  }
}

function renderFieldValue(
  value: string,
  onValue: (v: string) => void,
  field: FieldMeta | undefined,
  users: { id: string; name: string; email: string }[],
  teams: { id: string; name: string }[],
) {
  if (!field) return <input style={{ ...inputS, flex: 1 }} placeholder="Seleziona un campo" disabled />

  if (field.fieldType === 'enum' && field.enumValues.length > 0) {
    return (
      <select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Valore --</option>
        {field.enumValues.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  if (field.fieldType === 'user') {
    return (
      <select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Utente --</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
      </select>
    )
  }

  if (field.fieldType === 'team') {
    return (
      <select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Team --</option>
        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    )
  }

  if (field.fieldType === 'boolean') {
    return (
      <select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Valore --</option>
        <option value="true">Sì</option>
        <option value="false">No</option>
      </select>
    )
  }

  if (field.fieldType === 'date') {
    return <input type="date" style={{ ...inputS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)} />
  }

  if (field.fieldType === 'number') {
    return <input type="number" style={{ ...inputS, flex: 1 }} placeholder="Valore" value={value} onChange={e => onValue(e.target.value)} />
  }

  return <input style={{ ...inputS, flex: 1 }} placeholder="Valore" value={value} onChange={e => onValue(e.target.value)} />
}
