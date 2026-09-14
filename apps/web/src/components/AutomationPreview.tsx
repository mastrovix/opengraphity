/**
 * Real-time preview for trigger and business rule configurations.
 * Resolves field names, team/user IDs, and enum values to human-readable text.
 * Vocabolario (operatori, azioni, entità, eventi): lib/automationOperators.ts.
 */
import { useTranslation } from 'react-i18next'
import { useItilTypeLabels } from '@/hooks/useItilTypeLabels'
import { useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_TEAMS, GET_USERS } from '@/graphql/queries'
import { useEntityFieldLookup } from '@/hooks/useEntityFields'
import { palette } from '@/lib/tokens'
import {
  NO_VALUE_OPERATORS, automationActionKey, eventParticipleKey, operatorKey,
} from '@/lib/automationOperators'
import { Eye } from 'lucide-react'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

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
  const { t } = useTranslation()
  // F16: l'etichetta del tipo ITIL del cliente, non una tabella del web.
  const { labelOf } = useItilTypeLabels()
  const fieldLookup = useEntityFieldLookup(entityType)
  const { data: teamsData } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const { data: usersData } = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS, { fetchPolicy: METAMODEL_FETCH_POLICY })

  const teamMap = useMemo(() => new Map((teamsData?.teams ?? []).map(t => [t.id, t.name])), [teamsData])
  const userMap = useMemo(() => new Map((usersData?.users ?? []).map(u => [u.id, `${u.name} (${u.email})`])), [usersData])
  const logic = ` ${t((conditionLogic ?? 'and').toUpperCase() === 'OR' ? 'automation.sentence.or' : 'automation.sentence.and')} `

  // ── Build condition text ─────────────────────────────────────────────────
  const condText = conditions.length > 0
    ? conditions.map(c => {
        const meta      = fieldLookup.get(c.field)
        const fieldName = meta?.label ?? (c.field || '?')
        const op        = t(operatorKey(c.operator))
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
        const label = t(automationActionKey(a.type))
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
          case 'set_sla':        return `${label} ${t('automation.sentence.slaPair', { response: p['response_minutes'] ?? 0, resolve: p['resolve_minutes'] ?? 0 })}`
          case 'call_webhook':   return `${label} ${p['method'] ?? 'POST'} ${(p['url'] ?? '').slice(0, 30)}…`
          case 'execute_script': return `${label}`
          default: return label
        }
      }).join(', ')
    : null

  // ── Compose full preview ─────────────────────────────────────────────────
  const entityLabel = labelOf(entityType)
  const eventLabel  = t(eventParticipleKey(eventType))

  // La frase si compone di FRAMMENTI tradotti, non di pezzi cuciti in italiano:
  // «dopo N minuti» ha il plurale del client, e «SE / ALLORA» sono chiavi.
  const parts: string[] = [t('automation.sentence.when', { entity: entityLabel, event: eventLabel })]
  if (timerMinutes && timerMinutes > 0) parts.push(t('automation.sentence.afterMinutes', { count: timerMinutes }))
  if (condText) parts.push(t('automation.sentence.if',   { cond: condText }))
  if (actText)  parts.push(t('automation.sentence.then', { act: actText }))

  return (
    <div style={{ marginTop: 20, padding: '12px 16px', background: palette.info.light, borderRadius: 8, border: `1px solid ${palette.info.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Eye size={14} color={palette.info.text} />
        <span style={{ fontSize: 'var(--font-size-table)', fontWeight: 700, color: palette.info.text, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('automation.preview')}</span>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: palette.info.strong, lineHeight: 1.6 }}>
        {parts.join(', ')}
      </p>
    </div>
  )
}
