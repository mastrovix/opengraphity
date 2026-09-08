/**
 * Renders type-specific param inputs for automation actions.
 *
 * Due vocabolari (vedi lib/automationOperators.ts):
 *  - `automation` (default): auto-trigger e business rule (actionExecutor).
 *  - `workflow_step`: azioni enter/exit degli step di workflow
 *    (packages/workflow) — stessi controlli, parametri persistiti invariati.
 */
import { useQuery } from '@apollo/client/react'
import { GET_TEAMS, GET_WORKFLOW_LIST, GET_USERS } from '@/graphql/queries'
import { useEnumValues } from '@/hooks/useEnumValues'
import { useEntityFieldMetas, type FieldMeta } from '@/hooks/useEntityFields'
import { fieldTypeLabel } from '@/lib/automationOperators'
import { inputS, selectS } from '@/pages/settings/shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'

interface Props {
  actionType: string
  params:     Record<string, string>
  entityType: string
  onChange:   (key: string, value: string) => void
  vocabulary?: 'automation' | 'workflow_step'
}

const textareaS: React.CSSProperties = { ...inputS, minHeight: 60, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }
const monoS: React.CSSProperties     = { ...inputS, minHeight: 80, resize: 'vertical', fontFamily: 'monospace', fontSize: 'var(--font-size-body)', lineHeight: 1.5 }
const labelS: React.CSSProperties    = { fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 120 }}>
      <span style={labelS}>{label}</span>
      {children}
    </div>
  )
}

export function ActionParamsEditor({ actionType, params, entityType, onChange, vocabulary = 'automation' }: Props) {
  const { data: teamsData }    = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: 'cache-first' })
  const { data: usersData }    = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS, { fetchPolicy: 'cache-first' })
  const { data: workflowData } = useQuery<{ workflowDefinitions: { id: string; name: string; entityType: string; steps: { name: string; label: string }[] }[] }>(GET_WORKFLOW_LIST, { fetchPolicy: 'cache-first' })
  const { values: priorityValues } = useEnumValues(entityType || 'incident', 'priority')
  const { values: severityValues } = useEnumValues(entityType || 'incident', 'severity')
  const { fields: fieldMetas } = useEntityFieldMetas(entityType)

  const teams = teamsData?.teams ?? []
  const users = usersData?.users ?? []
  const steps = (workflowData?.workflowDefinitions ?? [])
    .filter(w => w.entityType === entityType)
    .flatMap(w => w.steps ?? [])
    .filter((s, i, arr) => arr.findIndex(x => x.name === s.name) === i)

  const selectedFieldMeta = fieldMetas.find(f => f.name === params['field'])

  const text = (key: string, label: string, placeholder = '', type = 'text') => (
    <Labeled key={key} label={label}>
      <Input type={type} style={inputS} placeholder={placeholder} value={params[key] ?? ''} onChange={e => onChange(key, e.target.value)} />
    </Labeled>
  )
  const choice = (key: string, label: string, options: { value: string; label?: string }[], fallback: string) => (
    <Labeled key={key} label={label}>
      <Select style={selectS} value={params[key] ?? fallback} onChange={e => onChange(key, e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
      </Select>
    </Labeled>
  )

  switch (actionType) {
    // ── Vocabolario automation (actionExecutor) ───────────────────────────────
    case 'assign_team':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['team_id'] ?? ''} onChange={e => onChange('team_id', e.target.value)}>
          <option value="">-- Seleziona team --</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      )

    case 'assign_user':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['user_id'] ?? ''} onChange={e => onChange('user_id', e.target.value)}>
          <option value="">-- Seleziona utente --</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
        </Select>
      )

    case 'transition_workflow':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['to_step'] ?? ''} onChange={e => onChange('to_step', e.target.value)}>
          <option value="">-- Seleziona step --</option>
          {steps.map(s => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
        </Select>
      )

    case 'set_priority':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['priority'] ?? ''} onChange={e => onChange('priority', e.target.value)}>
          <option value="">-- Seleziona priorità --</option>
          {(priorityValues.length > 0 ? priorityValues : severityValues).map(v =>
            <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
          )}
        </Select>
      )

    case 'set_field':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {/* Field dropdown */}
          <Select
            style={{ ...selectS, width: 160 }}
            value={params['field'] ?? ''}
            onChange={e => { onChange('field', e.target.value); onChange('value', '') }}
          >
            <option value="">-- Campo --</option>
            {fieldMetas.map(f => (
              <option key={f.name} value={f.name}>{f.label} ({fieldTypeLabel(f.fieldType)})</option>
            ))}
          </Select>
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
          <Select style={{ ...selectS, width: 90 }} value={params['method'] ?? 'POST'} onChange={e => onChange('method', e.target.value)}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="GET">GET</option>
          </Select>
          <Input style={{ ...inputS, flex: 1, minWidth: 200 }} placeholder="https://..." value={params['url'] ?? ''} onChange={e => onChange('url', e.target.value)} />
          {vocabulary === 'workflow_step' && text('payload_template', 'payload_template (JSON)', '{}')}
        </div>
      )

    case 'set_sla':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1 }}>
          <Input style={{ ...inputS, width: 100 }} type="number" placeholder="Risposta (min)" value={params['response_minutes'] ?? ''} onChange={e => onChange('response_minutes', e.target.value)} />
          <Input style={{ ...inputS, width: 100 }} type="number" placeholder="Risoluzione (min)" value={params['resolve_minutes'] ?? ''} onChange={e => onChange('resolve_minutes', e.target.value)} />
        </div>
      )

    // ── Vocabolario workflow_step (packages/workflow) ─────────────────────────
    case 'sla_start':
    case 'sla_stop':
      return choice('sla_type', 'sla_type', [{ value: 'response' }, { value: 'resolve' }], 'response')

    case 'schedule_job':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {text('job', 'job', 'auto_close')}
          {text('delay_hours', 'delay_hours', '0', 'number')}
        </div>
      )

    case 'cancel_job':
      return text('job', 'job', 'auto_close')

    case 'create_entity':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {choice('entity_type', 'entity_type', [{ value: 'incident' }, { value: 'problem' }, { value: 'change' }], 'incident')}
          {text('title_template', 'title_template', '{title} — escalated')}
          {choice('link_to_current', 'link_to_current', [{ value: 'true' }, { value: 'false' }], 'true')}
          {text('copy_fields', 'copy_fields (comma-sep)', 'severity,priority')}
        </div>
      )

    case 'assign_to': {
      const targetType = params['target_type'] ?? 'team'
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {choice('target_type', 'target_type', [{ value: 'team' }, { value: 'user' }], 'team')}
          <Labeled label="target_id">
            <Select style={selectS} value={params['target_id'] ?? ''} onChange={e => onChange('target_id', e.target.value)}>
              <option value="">-- {targetType === 'user' ? 'Utente' : 'Team'} --</option>
              {targetType === 'user'
                ? users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)
                : teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Labeled>
          {text('target_name', 'target_name (template)', '{assigned_team}')}
        </div>
      )
    }

    case 'update_field':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          <Labeled label="field">
            <Select style={selectS} value={params['field'] ?? 'severity'} onChange={e => onChange('field', e.target.value)}>
              {fieldMetas.filter(f => f.fieldType !== 'user' && f.fieldType !== 'team').map(f => (
                <option key={f.name} value={f.name}>{f.label} ({fieldTypeLabel(f.fieldType)})</option>
              ))}
            </Select>
          </Labeled>
          {/* Testo libero: il valore può essere un template ({field}), non solo un enum */}
          {text('value', 'value', 'critical or {field}')}
        </div>
      )

    case 'create_approval_request':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {text('title_template', 'title_template', 'Pubblicazione: {title}')}
          {choice('approver_role', 'approver_role', [{ value: 'admin' }, { value: 'manager' }], 'admin')}
          {choice('approval_type', 'approval_type', [
            { value: 'any', label: 'any (1 approver sufficient)' },
            { value: 'all', label: 'all (all approvers required)' },
            { value: 'majority', label: 'majority' },
          ], 'any')}
        </div>
      )

    default:
      return <Input style={{ ...inputS, flex: 1 }} placeholder="Parametri..." value={params['value'] ?? ''} onChange={e => onChange('value', e.target.value)} />
  }
}

function renderFieldValue(
  value: string,
  onValue: (v: string) => void,
  field: FieldMeta | undefined,
  users: { id: string; name: string; email: string }[],
  teams: { id: string; name: string }[],
) {
  if (!field) return <Input style={{ ...inputS, flex: 1 }} placeholder="Seleziona un campo" disabled />

  if (field.fieldType === 'enum' && field.enumValues.length > 0) {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Valore --</option>
        {field.enumValues.map(v => <option key={v} value={v}>{v}</option>)}
      </Select>
    )
  }

  if (field.fieldType === 'user') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Utente --</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
      </Select>
    )
  }

  if (field.fieldType === 'team') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Team --</option>
        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
    )
  }

  if (field.fieldType === 'boolean') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">-- Valore --</option>
        <option value="true">Sì</option>
        <option value="false">No</option>
      </Select>
    )
  }

  if (field.fieldType === 'date') {
    return <Input type="date" style={{ ...inputS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)} />
  }

  if (field.fieldType === 'number') {
    return <Input type="number" style={{ ...inputS, flex: 1 }} placeholder="Valore" value={value} onChange={e => onValue(e.target.value)} />
  }

  return <Input style={{ ...inputS, flex: 1 }} placeholder="Valore" value={value} onChange={e => onValue(e.target.value)} />
}
