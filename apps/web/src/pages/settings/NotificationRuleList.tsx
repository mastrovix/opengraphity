import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Lock, Unlock } from 'lucide-react'
import { colors, fontSize, fontWeight } from '@/lib/tokens'

// ── Re-exported from NotificationRulesPage ────────────────────────────────────

export const SEVERITY_COLOR: Record<string, string> = {
  info:    '#0284c7',
  success: '#22c55e',
  warning: '#eab308',
  error:   '#ef4444',
}

const CHANNELS_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'in_app', labelKey: 'notificationRules.channels.inApp' },
  { value: 'slack',  labelKey: 'notificationRules.channels.slack' },
  { value: 'teams',  labelKey: 'notificationRules.channels.teams' },
  { value: 'email',  labelKey: 'notificationRules.channels.email' },
]

const SEVERITY_OPTIONS = ['info', 'success', 'warning', 'error'] as const

const TARGET_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'all',          labelKey: 'notificationRules.target.all'         },
  { value: 'assignee',     labelKey: 'notificationRules.target.assignee'    },
  { value: 'team_owner',   labelKey: 'notificationRules.target.teamOwner'   },
  { value: 'role:admin',   labelKey: 'notificationRules.target.adminOnly'   },
  { value: 'role:manager', labelKey: 'notificationRules.target.managerOnly' },
]

const selectStyle: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 4,
  fontSize: 12, background: '#fafafa', cursor: 'pointer', width: '100%',
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NotificationRule {
  id:               string
  eventType:        string
  enabled:          boolean
  severityOverride: string
  titleKey:         string
  channels:         string[]
  target:           string
  isSeed:           boolean
  escalationDelayMinutes?:     number | null
  escalationTarget?:           string | null
  escalationMessage?:          string | null
  slaWarningThresholdPercent?: number | null
  slaWarningTarget?:           string | null
  digestTime?:                 string | null
  digestRecipients?:           string[] | null
}

export interface UpdateInput {
  enabled?:          boolean
  severityOverride?: string
  channels?:         string[]
  target?:           string
}

// ── Toggle ────────────────────────────────────────────────────────────────────

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
        backgroundColor: value ? colors.brand : '#cbd5e1',
        position: 'relative', transition: 'background 200ms', flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: value ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        transition: 'left 200ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </div>
  )
}

// ── RuleRow ───────────────────────────────────────────────────────────────────

export function RuleRow({
  rule,
  onUpdate,
  onDelete,
}: {
  rule:     NotificationRule
  onUpdate: (id: string, input: UpdateInput) => void
  onDelete: (id: string) => void
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

  const titleLabel = t(rule.titleKey, { defaultValue: '' }) || rule.eventType

  return (
    <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
      {/* Enabled */}
      <td style={{ padding: '10px 12px', width: 52 }}>
        <Toggle value={rule.enabled} onChange={(v) => debounce({ enabled: v })} />
      </td>

      {/* Event */}
      <td style={{ padding: '10px 12px', fontSize: fontSize.table, color: '#0f172a', fontWeight: fontWeight.medium }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {titleLabel}
          {rule.isSeed
            ? <span title={t('notificationRules.systemRule',   'Regola di sistema')}     style={{ display: 'inline-flex', flexShrink: 0 }}><Lock   size={14} color="#94a3b8" /></span>
            : <span title={t('notificationRules.customRule',   'Regola personalizzata')} style={{ display: 'inline-flex', flexShrink: 0 }}><Unlock size={14} color="#94a3b8" /></span>
          }
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', marginTop: 1 }}>{rule.eventType}</div>
      </td>

      {/* Severity */}
      <td style={{ padding: '10px 12px', width: 120 }}>
        <select
          value={rule.severityOverride}
          onChange={(e) => debounce({ severityOverride: e.target.value })}
          style={{ ...selectStyle, color: SEVERITY_COLOR[rule.severityOverride] ?? '#64748b', fontWeight: fontWeight.medium }}
        >
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s} style={{ color: SEVERITY_COLOR[s] }}>{t(`notificationRules.severity.${s}`)}</option>
          ))}
        </select>
      </td>

      {/* Channels */}
      <td style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {CHANNELS_OPTIONS.map(({ value, labelKey }) => (
            <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: '#64748b' }}>
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
        <select value={rule.target} onChange={(e) => debounce({ target: e.target.value })} style={{ ...selectStyle, color: '#64748b' }}>
          {TARGET_OPTIONS.map(({ value, labelKey }) => (
            <option key={value} value={value}>{t(labelKey)}</option>
          ))}
        </select>
      </td>

      {/* Delete (custom rules only) */}
      <td style={{ padding: '10px 8px', width: 36, textAlign: 'center' }}>
        {!rule.isSeed && (
          <button
            onClick={() => onDelete(rule.id)}
            title={t('notificationRules.deleteRule')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 4,
              color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ef4444' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#94a3b8' }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  )
}
