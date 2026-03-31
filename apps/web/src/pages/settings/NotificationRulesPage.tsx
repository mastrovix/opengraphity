import { useCallback, useRef } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { GET_NOTIFICATION_RULES } from '@/graphql/queries'
import { UPDATE_NOTIFICATION_RULE } from '@/graphql/mutations'
import { colors, fontSize, fontWeight } from '@/lib/tokens'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotificationRule {
  id:               string
  eventType:        string
  enabled:          boolean
  severityOverride: string
  titleKey:         string
  channels:         string[]
  target:           string
}

interface UpdateInput {
  enabled?:          boolean
  severityOverride?: string
  channels?:         string[]
  target?:           string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { key: string; events: string[] }[] = [
  {
    key: 'Incident',
    events: [
      'incident.created', 'incident.assigned', 'incident.in_progress',
      'incident.on_hold', 'incident.escalated', 'incident.resolved', 'incident.closed',
    ],
  },
  {
    key: 'Change',
    events: [
      'change.approved', 'change.completed', 'change.failed',
      'change.rejected', 'change.task_assigned',
    ],
  },
  {
    key: 'Problem',
    events: [
      'problem.created', 'problem.under_investigation', 'problem.deferred',
      'problem.resolved', 'problem.closed',
    ],
  },
  {
    key: 'SLA',
    events: ['sla.warning', 'sla.breached'],
  },
]

const CHANNELS_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'in_app', labelKey: 'notificationRules.channels.inApp'  },
  { value: 'slack',  labelKey: 'notificationRules.channels.slack'  },
  { value: 'teams',  labelKey: 'notificationRules.channels.teams'  },
  { value: 'email',  labelKey: 'notificationRules.channels.email'  },
]

const SEVERITY_OPTIONS = ['info', 'success', 'warning', 'error']

const TARGET_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'all',          labelKey: 'notificationRules.target.all'        },
  { value: 'assignee',     labelKey: 'notificationRules.target.assignee'   },
  { value: 'team_owner',   labelKey: 'notificationRules.target.teamOwner'  },
  { value: 'role:admin',   labelKey: 'notificationRules.target.adminOnly'  },
  { value: 'role:manager', labelKey: 'notificationRules.target.managerOnly'},
]

const SEVERITY_COLOR: Record<string, string> = {
  info:    '#0284c7',
  success: '#22c55e',
  warning: '#eab308',
  error:   '#ef4444',
}

// ── Row component ─────────────────────────────────────────────────────────────

function RuleRow({
  rule,
  onUpdate,
}: {
  rule:     NotificationRule
  onUpdate: (id: string, input: UpdateInput) => void
}) {
  const { t } = useTranslation()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const debounce = useCallback((input: UpdateInput) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => onUpdate(rule.id, input), 500)
  }, [onUpdate, rule.id])

  const toggleChannel = (ch: string) => {
    const next = rule.channels.includes(ch)
      ? rule.channels.filter((c) => c !== ch)
      : [...rule.channels, ch]
    debounce({ channels: next })
  }

  const titleLabel = (() => {
    const translated = t(rule.titleKey, { defaultValue: '' })
    return translated || rule.eventType
  })()

  return (
    <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
      {/* Enabled */}
      <td style={{ padding: '10px 12px', width: 52 }}>
        <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
          <div
            onClick={() => debounce({ enabled: !rule.enabled })}
            style={{
              width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
              backgroundColor: rule.enabled ? colors.brand : '#cbd5e1',
              position: 'relative', transition: 'background 200ms', flexShrink: 0,
            }}
          >
            <div style={{
              position: 'absolute', top: 2, left: rule.enabled ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: '#fff',
              transition: 'left 200ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </div>
        </label>
      </td>

      {/* Event title */}
      <td style={{ padding: '10px 12px', fontSize: fontSize.table, color: '#0f172a', fontWeight: fontWeight.medium }}>
        {titleLabel}
        <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', marginTop: 1 }}>
          {rule.eventType}
        </div>
      </td>

      {/* Severity */}
      <td style={{ padding: '10px 12px', width: 120 }}>
        <select
          value={rule.severityOverride}
          onChange={(e) => debounce({ severityOverride: e.target.value })}
          style={{
            padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 4,
            fontSize: 12, color: SEVERITY_COLOR[rule.severityOverride] ?? '#64748b',
            background: '#fafafa', cursor: 'pointer', width: '100%',
            fontWeight: fontWeight.medium,
          }}
        >
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s} style={{ color: SEVERITY_COLOR[s] }}>
              {t(`notificationRules.severity.${s}`)}
            </option>
          ))}
        </select>
      </td>

      {/* Channels */}
      <td style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {CHANNELS_OPTIONS.map(({ value, labelKey }) => (
            <label
              key={value}
              style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: '#64748b' }}
            >
              <input
                type="checkbox"
                checked={rule.channels.includes(value)}
                onChange={() => toggleChannel(value)}
                style={{ accentColor: colors.brand, width: 13, height: 13 }}
              />
              {t(labelKey)}
            </label>
          ))}
        </div>
      </td>

      {/* Target */}
      <td style={{ padding: '10px 12px', width: 160 }}>
        <select
          value={rule.target}
          onChange={(e) => debounce({ target: e.target.value })}
          style={{
            padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 4,
            fontSize: 12, color: '#64748b', background: '#fafafa', cursor: 'pointer', width: '100%',
          }}
        >
          {TARGET_OPTIONS.map(({ value, labelKey }) => (
            <option key={value} value={value}>{t(labelKey)}</option>
          ))}
        </select>
      </td>
    </tr>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NotificationRulesPage() {
  const { t } = useTranslation()

  const { data, loading } = useQuery<{ notificationRules: NotificationRule[] }>(
    GET_NOTIFICATION_RULES,
    { fetchPolicy: 'cache-and-network' },
  )

  const [updateRule] = useMutation<{ updateNotificationRule: NotificationRule }>(UPDATE_NOTIFICATION_RULE, {
    refetchQueries: [{ query: GET_NOTIFICATION_RULES }],
  })

  const handleUpdate = useCallback((id: string, input: UpdateInput) => {
    updateRule({ variables: { id, input } })
  }, [updateRule])

  const rulesByEvent = (data?.notificationRules ?? []).reduce<Record<string, NotificationRule>>(
    (acc, r) => { acc[r.eventType] = r; return acc },
    {},
  )

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100 }}>
      <h1 style={{ fontSize: fontSize.pageTitle, fontWeight: fontWeight.bold, color: '#0f172a', margin: '0 0 6px' }}>
        {t('notificationRules.title')}
      </h1>
      <p style={{ fontSize: fontSize.body, color: '#64748b', margin: '0 0 28px' }}>
        {t('notificationRules.description')}
      </p>

      {loading && !data ? (
        <div style={{ color: '#94a3b8', fontSize: fontSize.body }}>{t('common.loading', 'Caricamento…')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {CATEGORIES.map(({ key, events }) => {
            const rules = events.map((e) => rulesByEvent[e]).filter(Boolean) as NotificationRule[]
            if (!rules.length) return null
            return (
              <section key={key}>
                <h2 style={{
                  fontSize: fontSize.sectionTitle, fontWeight: fontWeight.semibold,
                  color: '#0f172a', margin: '0 0 10px', paddingBottom: 8,
                  borderBottom: '2px solid #e2e8f0',
                }}>
                  {t(`notificationRules.category.${key.toLowerCase()}`, key)}
                </h2>

                <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: fontWeight.semibold, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', width: 52 }}>
                          {t('notificationRules.enabled')}
                        </th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: fontWeight.semibold, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          {t('notificationRules.event')}
                        </th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: fontWeight.semibold, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', width: 120 }}>
                          {t('notificationRules.severity')}
                        </th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: fontWeight.semibold, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          {t('notificationRules.channels')}
                        </th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: fontWeight.semibold, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', width: 160 }}>
                          {t('notificationRules.target')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((rule) => (
                        <RuleRow key={rule.id} rule={rule} onUpdate={handleUpdate} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
