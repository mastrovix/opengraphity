/**
 * Real-time preview for trigger and business rule configurations.
 * Resolves field names, team/user IDs, and enum values to human-readable text.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { GET_ITIL_TYPES, GET_CI_TYPES, GET_TEAMS } from '@/graphql/queries'
import { Eye } from 'lucide-react'

const GET_USERS_PREVIEW = gql`query GetUsersPreview { users { id name email } }`

interface Condition { field: string; operator: string; value: string }
interface Action { type: string; params: Record<string, string> }

interface Props {
  entityType:     string
  eventType:      string
  conditions:     Condition[]
  conditionLogic?: 'and' | 'or' | 'AND' | 'OR'
  actions:        Action[]
  timerMinutes?:  number | null
}

// ── Lookups ──────────────────────────────────────────────────────────────────

const ITIL_ENTITIES = new Set(['incident', 'problem', 'change', 'service_request'])

const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'Service Request',
}

const EVENT_LABELS: Record<string, string> = {
  on_create: 'creato', on_update: 'aggiornato', on_timer: 'creato',
  on_sla_breach: 'in breach SLA', on_field_change: 'modificato',
  on_transition: 'transizionato',
}

const OP_LABELS: Record<string, string> = {
  equals: '=', not_equals: '≠', is_null: 'è vuoto', is_not_null: 'non è vuoto',
  greater_than: '>', less_than: '<', contains: 'contiene',
}

const NO_VALUE_OPS = new Set(['is_null', 'is_not_null'])

const ACTION_LABELS: Record<string, string> = {
  set_field: 'Imposta campo', assign_team: 'Assegna team', assign_user: 'Assegna utente',
  transition_workflow: 'Transizione', create_notification: 'Notifica',
  create_comment: 'Commento', set_priority: 'Imposta priorità',
  execute_script: 'Esegui script', call_webhook: 'Chiama webhook', set_sla: 'Imposta SLA',
}

// ── Hooks ────────────────────────────────────────────────────────────────────

interface FieldMeta { name: string; label: string; fieldType: string; enumValues: string[] }
type TypeDef = { name: string; fields: { name: string; label: string; fieldType: string; enumValues?: string[] | null }[] }

function useFieldLookup(entityType: string): Map<string, FieldMeta> {
  const isITIL = ITIL_ENTITIES.has(entityType)
  const { data: itilData } = useQuery(GET_ITIL_TYPES, { skip: !isITIL, fetchPolicy: 'cache-first' })
  const { data: ciData }   = useQuery(GET_CI_TYPES,   { skip: isITIL, fetchPolicy: 'cache-first' })

  return useMemo(() => {
    const map = new Map<string, FieldMeta>()
    const types = isITIL
      ? (itilData as { itilTypes?: TypeDef[] } | undefined)?.itilTypes
      : (ciData   as { ciTypes?:   TypeDef[] } | undefined)?.ciTypes
    const typeDef = (types ?? []).find(t => t.name === entityType)
    if (typeDef) {
      for (const f of typeDef.fields) {
        map.set(f.name, { name: f.name, label: f.label || f.name, fieldType: f.fieldType, enumValues: f.enumValues ?? [] })
      }
    }
    map.set('assigned_to',   { name: 'assigned_to',   label: 'Assegnato a',     fieldType: 'user', enumValues: [] })
    map.set('assigned_team', { name: 'assigned_team', label: 'Team assegnato', fieldType: 'team', enumValues: [] })
    return map
  }, [isITIL, entityType, itilData, ciData])
}

// ── Component ────────────────────────────────────────────────────────────────

export function AutomationPreview({ entityType, eventType, conditions, conditionLogic, actions, timerMinutes }: Props) {
  const fieldLookup = useFieldLookup(entityType)
  const { data: teamsData } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: 'cache-first' })
  const { data: usersData } = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS_PREVIEW, { fetchPolicy: 'cache-first' })

  const teamMap = useMemo(() => new Map((teamsData?.teams ?? []).map(t => [t.id, t.name])), [teamsData])
  const userMap = useMemo(() => new Map((usersData?.users ?? []).map(u => [u.id, `${u.name} (${u.email})`])), [usersData])
  const logic = (conditionLogic ?? 'and').toUpperCase() === 'OR' ? ' O ' : ' E '

  // ── Build condition text ─────────────────────────────────────────────────
  const condText = conditions.length > 0
    ? conditions.map(c => {
        const meta      = fieldLookup.get(c.field)
        const fieldName = meta?.label ?? (c.field || '?')
        const op        = OP_LABELS[c.operator] ?? c.operator
        if (NO_VALUE_OPS.has(c.operator)) return `${fieldName} ${op}`
        let val = c.value
        // Resolve IDs to names
        if (meta?.fieldType === 'user') val = userMap.get(c.value) ?? c.value
        if (meta?.fieldType === 'team') val = teamMap.get(c.value) ?? c.value
        return `${fieldName} ${op} "${val}"`
      }).join(logic)
    : null

  // ── Build action text ────────────────────────────────────────────────────
  const actText = actions.length > 0
    ? actions.map(a => {
        const p = a.params ?? {}
        const label = ACTION_LABELS[a.type] ?? a.type
        switch (a.type) {
          case 'assign_team':    return `${label} ${teamMap.get(p['team_id'] ?? '') ?? p['team_id'] ?? '?'}`
          case 'assign_user':    return `${label} ${userMap.get(p['user_id'] ?? '') ?? p['user_id'] ?? '?'}`
          case 'transition_workflow': return `${label} → ${p['to_step'] ?? '?'}`
          case 'set_priority':   return `${label} → ${p['priority'] ?? '?'}`
          case 'set_field': {
            const fMeta = fieldLookup.get(p['field'] ?? '')
            return `${label} ${fMeta?.label ?? p['field'] ?? '?'} = "${p['value'] ?? ''}"`
          }
          case 'create_notification': return `${label}: "${(p['message'] ?? '').slice(0, 40)}${(p['message'] ?? '').length > 40 ? '…' : ''}"`
          case 'create_comment': return `${label}: "${(p['text'] ?? '').slice(0, 40)}${(p['text'] ?? '').length > 40 ? '…' : ''}"`
          case 'set_sla':        return `${label} risposta:${p['response_minutes'] ?? 0}min risoluzione:${p['resolve_minutes'] ?? 0}min`
          case 'call_webhook':   return `${label} ${p['method'] ?? 'POST'} ${(p['url'] ?? '').slice(0, 30)}…`
          case 'execute_script': return `${label}`
          default: return label
        }
      }).join(', ')
    : null

  // ── Compose full preview ─────────────────────────────────────────────────
  const entityLabel = ENTITY_LABELS[entityType] ?? entityType
  const eventLabel  = EVENT_LABELS[eventType] ?? eventType

  const parts: string[] = [`Quando un ${entityLabel} viene ${eventLabel}`]
  if (timerMinutes && timerMinutes > 0) parts.push(`dopo ${timerMinutes} minut${timerMinutes === 1 ? 'o' : 'i'}`)
  if (condText) parts.push(`SE ${condText}`)
  if (actText)  parts.push(`ALLORA ${actText}`)

  return (
    <div style={{ marginTop: 20, padding: '12px 16px', background: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Eye size={14} color="#0369a1" />
        <span style={{ fontSize: 11, fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', letterSpacing: 0.5 }}>Anteprima</span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: '#0c4a6e', lineHeight: 1.6 }}>
        {parts.join(', ')}
      </p>
    </div>
  )
}
