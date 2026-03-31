import { useCallback, useRef, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Trash2, Plus, X } from 'lucide-react'
import { GET_NOTIFICATION_RULES } from '@/graphql/queries'
import { UPDATE_NOTIFICATION_RULE, CREATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE } from '@/graphql/mutations'
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
  isSeed:           boolean
}

interface UpdateInput {
  enabled?:          boolean
  severityOverride?: string
  channels?:         string[]
  target?:           string
}

interface CreateInput {
  eventType:        string
  enabled:          boolean
  severityOverride: string
  titleKey:         string
  channels:         string[]
  target:           string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STANDARD_EVENTS = [
  'incident.created', 'incident.assigned', 'incident.in_progress',
  'incident.on_hold', 'incident.escalated', 'incident.resolved', 'incident.closed',
  'change.approved', 'change.completed', 'change.failed', 'change.rejected', 'change.task_assigned',
  'problem.created', 'problem.under_investigation', 'problem.deferred', 'problem.resolved', 'problem.closed',
  'sla.warning', 'sla.breached',
]

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

const SEVERITY_COLOR: Record<string, string> = {
  info:    '#0284c7',
  success: '#22c55e',
  warning: '#eab308',
  error:   '#ef4444',
}

const TH: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', fontSize: 11,
  fontWeight: fontWeight.semibold, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

// ── Toggle ─────────────────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
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

// ── Inline select / checkbox helpers ──────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 4,
  fontSize: 12, background: '#fafafa', cursor: 'pointer', width: '100%',
}

// ── RuleRow ───────────────────────────────────────────────────────────────────

function RuleRow({
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
        {titleLabel}
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

// ── New Rule Dialog ────────────────────────────────────────────────────────────

const CUSTOM_SENTINEL = '__custom__'

function NewRuleDialog({
  onSave,
  onClose,
  saving,
}: {
  onSave:  (input: CreateInput) => void
  onClose: () => void
  saving:  boolean
}) {
  const { t } = useTranslation()
  const [eventTypeSelect, setEventTypeSelect] = useState('')
  const [customEventType, setCustomEventType] = useState('')
  const [titleKey,         setTitleKey]        = useState('')
  const [severity,         setSeverity]        = useState<string>('info')
  const [channels,         setChannels]        = useState<string[]>(['in_app'])
  const [target,           setTarget]          = useState('all')

  const isCustom     = eventTypeSelect === CUSTOM_SENTINEL
  const eventType    = isCustom ? customEventType.trim() : eventTypeSelect
  const canSave      = !!eventType && !!titleKey.trim() && channels.length > 0

  const toggleCh = (ch: string) =>
    setChannels((prev) => prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch])

  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 6,
    fontSize: 13, color: '#0f172a', background: '#fafafa', width: '100%', boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 5,
  }

  const labelTextStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: fontWeight.semibold, color: '#94a3b8',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  }

  return (
    /* Backdrop */
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 12, padding: 28, width: 480,
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 16, fontWeight: fontWeight.bold, color: '#0f172a' }}>
            {t('notificationRules.addRule')}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 0 }}>
            <X size={18} />
          </button>
        </div>

        {/* Event type */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.eventType')}</span>
          <select value={eventTypeSelect} onChange={(e) => setEventTypeSelect(e.target.value)} style={inputStyle}>
            <option value="">— {t('common.select', 'Seleziona')} —</option>
            <optgroup label="Standard">
              {STANDARD_EVENTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </optgroup>
            <option value={CUSTOM_SENTINEL}>{t('notificationRules.customEvent')}</option>
          </select>
        </label>

        {isCustom && (
          <label style={labelStyle}>
            <span style={labelTextStyle}>{t('notificationRules.eventType')} (custom)</span>
            <input
              value={customEventType}
              onChange={(e) => setCustomEventType(e.target.value)}
              placeholder="es. workflow.step.entered"
              style={inputStyle}
              autoFocus
            />
          </label>
        )}

        {/* Title key */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.titleKey')}</span>
          <input
            value={titleKey}
            onChange={(e) => setTitleKey(e.target.value)}
            placeholder="es. notification.custom.my_event.title"
            style={inputStyle}
          />
        </label>

        {/* Severity */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.header.severity')}</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ ...inputStyle, color: SEVERITY_COLOR[severity] ?? '#64748b', fontWeight: fontWeight.medium }}>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s} style={{ color: SEVERITY_COLOR[s] }}>{t(`notificationRules.severity.${s}`)}</option>
            ))}
          </select>
        </label>

        {/* Channels */}
        <div style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.header.channels')}</span>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {CHANNELS_OPTIONS.map(({ value, labelKey }) => (
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: '#64748b' }}>
                <input
                  type="checkbox"
                  checked={channels.includes(value)}
                  onChange={() => toggleCh(value)}
                  style={{ accentColor: colors.brand, width: 14, height: 14 }}
                />
                {t(labelKey)}
              </label>
            ))}
          </div>
        </div>

        {/* Target */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.header.target')}</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...inputStyle, color: '#64748b' }}>
            {TARGET_OPTIONS.map(({ value, labelKey }) => (
              <option key={value} value={value}>{t(labelKey)}</option>
            ))}
          </select>
        </label>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px', borderRadius: 6, border: '1px solid #e2e8f0',
              fontSize: 13, cursor: 'pointer', background: '#fafafa', color: '#64748b',
            }}
          >
            {t('notificationRules.cancel')}
          </button>
          <button
            onClick={() => onSave({ eventType, titleKey: titleKey.trim(), severityOverride: severity, channels, target, enabled: true })}
            disabled={!canSave || saving}
            style={{
              padding: '8px 18px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: fontWeight.semibold,
              cursor: canSave && !saving ? 'pointer' : 'not-allowed',
              background: canSave && !saving ? colors.brand : '#e2e8f0',
              color: canSave && !saving ? '#fff' : '#94a3b8',
            }}
          >
            {saving ? '…' : t('notificationRules.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NotificationRulesPage() {
  const { t } = useTranslation()
  const [showDialog, setShowDialog] = useState(false)

  const { data, loading } = useQuery<{ notificationRules: NotificationRule[] }>(
    GET_NOTIFICATION_RULES,
    { fetchPolicy: 'cache-and-network' },
  )

  const refetchQ = [{ query: GET_NOTIFICATION_RULES }]

  const [updateRule] = useMutation<{ updateNotificationRule: NotificationRule }>(
    UPDATE_NOTIFICATION_RULE,
    { refetchQueries: refetchQ },
  )

  const [createRule, { loading: creating }] = useMutation<{ createNotificationRule: NotificationRule }>(
    CREATE_NOTIFICATION_RULE,
    { refetchQueries: refetchQ },
  )

  const [deleteRule] = useMutation<{ deleteNotificationRule: boolean }>(
    DELETE_NOTIFICATION_RULE,
    { refetchQueries: refetchQ },
  )

  const handleUpdate = useCallback((id: string, input: UpdateInput) => {
    updateRule({ variables: { id, input } })
  }, [updateRule])

  const handleCreate = useCallback((input: CreateInput) => {
    createRule({ variables: { input } }).then(() => setShowDialog(false))
  }, [createRule])

  const handleDelete = useCallback((id: string) => {
    if (window.confirm(t('notificationRules.deleteRule') + '?')) {
      deleteRule({ variables: { id } })
    }
  }, [deleteRule, t])

  const allRules   = data?.notificationRules ?? []
  const byEvent    = allRules.reduce<Record<string, NotificationRule>>((acc, r) => { acc[r.eventType] = r; return acc }, {})
  const customRules = allRules.filter((r) => !STANDARD_EVENTS.includes(r.eventType))

  const tableHeader = (
    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
      <th style={{ ...TH, width: 52 }}>{t('notificationRules.enabled')}</th>
      <th style={TH}>{t('notificationRules.event')}</th>
      <th style={{ ...TH, width: 120 }}>{t('notificationRules.header.severity')}</th>
      <th style={TH}>{t('notificationRules.header.channels')}</th>
      <th style={{ ...TH, width: 160 }}>{t('notificationRules.header.target')}</th>
      <th style={{ ...TH, width: 36 }} />
    </tr>
  )

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1140 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: fontSize.pageTitle, fontWeight: fontWeight.bold, color: '#0f172a', margin: '0 0 6px' }}>
            {t('notificationRules.title')}
          </h1>
          <p style={{ fontSize: fontSize.body, color: '#64748b', margin: 0 }}>
            {t('notificationRules.description')}
          </p>
        </div>
        <button
          onClick={() => setShowDialog(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 7, border: 'none',
            background: colors.brand, color: '#fff',
            fontSize: 13, fontWeight: fontWeight.semibold, cursor: 'pointer', flexShrink: 0,
          }}
        >
          <Plus size={14} />
          {t('notificationRules.addRule')}
        </button>
      </div>

      {loading && !data ? (
        <div style={{ color: '#94a3b8', fontSize: fontSize.body }}>{t('common.loading', 'Caricamento…')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {CATEGORIES.map(({ key, events }) => {
            const rules = events.map((e) => byEvent[e]).filter(Boolean) as NotificationRule[]
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
                    <thead>{tableHeader}</thead>
                    <tbody>
                      {rules.map((rule) => (
                        <RuleRow key={rule.id} rule={rule} onUpdate={handleUpdate} onDelete={handleDelete} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })}

          {/* Custom rules */}
          {customRules.length > 0 && (
            <section>
              <h2 style={{
                fontSize: fontSize.sectionTitle, fontWeight: fontWeight.semibold,
                color: '#0f172a', margin: '0 0 10px', paddingBottom: 8,
                borderBottom: '2px solid #e2e8f0',
              }}>
                {t('notificationRules.category.custom', 'Custom')}
              </h2>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>{tableHeader}</thead>
                  <tbody>
                    {customRules.map((rule) => (
                      <RuleRow key={rule.id} rule={rule} onUpdate={handleUpdate} onDelete={handleDelete} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {showDialog && (
        <NewRuleDialog
          onSave={handleCreate}
          onClose={() => setShowDialog(false)}
          saving={creating}
        />
      )}
    </div>
  )
}
