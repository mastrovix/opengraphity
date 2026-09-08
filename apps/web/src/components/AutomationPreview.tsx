/**
 * Real-time preview for trigger and business rule configurations.
 * Resolves field names, team/user IDs, and enum values to human-readable text.
 * Vocabolario (operatori, azioni, entità, eventi): lib/automationOperators.ts.
 */
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_TEAMS, GET_USERS } from '@/graphql/queries'
import { useEntityFieldLookup } from '@/hooks/useEntityFields'
import { lookupOrError } from '@/lib/tokens'
import {
  ENTITY_LABELS, EVENT_LABELS, NO_VALUE_OPERATORS, automationActionLabel, operatorLabel,
} from '@/lib/automationOperators'
import { Eye } from 'lucide-react'

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

// ── Component ────────────────────────────────────────────────────────────────

export function AutomationPreview({ entityType, eventType, conditions, conditionLogic, actions, timerMinutes }: Props) {
  const fieldLookup = useEntityFieldLookup(entityType)
  const { data: teamsData } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: 'cache-first' })
  const { data: usersData } = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS, { fetchPolicy: 'cache-first' })

  const teamMap = useMemo(() => new Map((teamsData?.teams ?? []).map(t => [t.id, t.name])), [teamsData])
  const userMap = useMemo(() => new Map((usersData?.users ?? []).map(u => [u.id, `${u.name} (${u.email})`])), [usersData])
  const logic = (conditionLogic ?? 'and').toUpperCase() === 'OR' ? ' O ' : ' E '

  // ── Build condition text ─────────────────────────────────────────────────
  const condText = conditions.length > 0
    ? conditions.map(c => {
        const meta      = fieldLookup.get(c.field)
        const fieldName = meta?.label ?? (c.field || '?')
        const op        = operatorLabel(c.operator)
        if (NO_VALUE_OPERATORS.has(c.operator)) return `${fieldName} ${op}`
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
        const label = automationActionLabel(a.type)
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
  const entityLabel = lookupOrError(ENTITY_LABELS, entityType, 'ENTITY_LABELS', `?${entityType}`)
  const eventLabel  = lookupOrError(EVENT_LABELS, eventType, 'EVENT_LABELS', `?${eventType}`)

  const parts: string[] = [`Quando un ${entityLabel} viene ${eventLabel}`]
  if (timerMinutes && timerMinutes > 0) parts.push(`dopo ${timerMinutes} minut${timerMinutes === 1 ? 'o' : 'i'}`)
  if (condText) parts.push(`SE ${condText}`)
  if (actText)  parts.push(`ALLORA ${actText}`)

  return (
    <div style={{ marginTop: 20, padding: '12px 16px', background: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Eye size={14} color="#0369a1" />
        <span style={{ fontSize: 'var(--font-size-table)', fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', letterSpacing: 0.5 }}>Anteprima</span>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: '#0c4a6e', lineHeight: 1.6 }}>
        {parts.join(', ')}
      </p>
    </div>
  )
}
