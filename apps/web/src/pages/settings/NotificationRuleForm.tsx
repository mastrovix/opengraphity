import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { colors, fontWeight, lookupOrError } from '@/lib/tokens'
import { SEVERITY_COLOR } from './NotificationRuleList'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateInput {
  eventType:        string
  enabled:          boolean
  severityOverride: string
  titleKey:         string
  channels:         string[]
  target:           string
  escalationDelayMinutes?:     number | null
  escalationTarget?:           string | null
  escalationMessage?:          string | null
  slaWarningThresholdPercent?: number | null
  slaWarningTarget?:           string | null
  digestTime?:                 string | null
  digestRecipients?:           string[] | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STANDARD_EVENTS = [
  'incident.created', 'incident.assigned', 'incident.in_progress',
  'incident.on_hold', 'incident.escalated', 'incident.resolved', 'incident.closed',
  'incident.escalation',
  'change.approved', 'change.completed', 'change.failed', 'change.rejected', 'change.task_assigned',
  'problem.created', 'problem.under_investigation', 'problem.deferred', 'problem.resolved', 'problem.closed',
  'sla.warning', 'sla.breached',
  'digest.daily',
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

const CUSTOM_SENTINEL = '__custom__'

// ── NewRuleDialog ─────────────────────────────────────────────────────────────

export function NewRuleDialog({
  onSave,
  onClose,
  saving,
}: {
  onSave:  (input: CreateInput) => void
  onClose: () => void
  saving:  boolean
}) {
  const { t } = useTranslation()
  const [eventTypeSelect, setEventTypeSelect]   = useState('')
  const [customEventType, setCustomEventType]   = useState('')
  const [titleKey,         setTitleKey]          = useState('')
  const [severity,         setSeverity]          = useState<string>('info')
  const [channels,         setChannels]          = useState<string[]>(['in_app'])
  const [target,           setTarget]            = useState('all')
  // Escalation fields
  const [escalationDelay,   setEscalationDelay]  = useState('')
  const [escalationTarget,  setEscalationTarget] = useState('')
  const [escalationMessage, setEscalationMessage]= useState('')
  // SLA warning fields
  const [slaThreshold,     setSlaThreshold]      = useState('80')
  const [slaTarget,        setSlaTarget]         = useState('all')
  // Digest fields
  const [digestTime,       setDigestTime]        = useState('08:00')

  const isCustom          = eventTypeSelect === CUSTOM_SENTINEL
  const eventType         = isCustom ? customEventType.trim() : eventTypeSelect
  const isEscalation      = eventType === 'incident.escalation'
  const isSlaWarning      = eventType === 'sla.warning'
  const isDigest          = eventType === 'digest.daily'
  const canSave           = !!eventType && !!titleKey.trim() && channels.length > 0

  const toggleCh = (ch: string) =>
    setChannels((prev) => prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch])

  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', border: '1px solid #e2e8f0', borderRadius: 6,
    fontSize: 'var(--font-size-body)', color: '#0f172a', background: '#fafafa', width: '100%', boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 5,
  }

  const labelTextStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-table)', fontWeight: fontWeight.semibold, color: '#94a3b8',
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
          <span style={{ fontSize: 'var(--font-size-section-title)', fontWeight: fontWeight.bold, color: '#0f172a' }}>
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
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ ...inputStyle, color: lookupOrError(SEVERITY_COLOR, severity, 'SEVERITY_COLOR', '#64748b'), fontWeight: fontWeight.medium }}>
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
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: '#64748b' }}>
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

        {/* Escalation conditional fields */}
        {isEscalation && (
          <>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Ritardo escalation (minuti)</span>
              <input type="number" min={1} value={escalationDelay} onChange={e => setEscalationDelay(e.target.value)} style={inputStyle} placeholder="es. 30" />
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Target escalation (userId o &apos;all&apos;)</span>
              <input value={escalationTarget} onChange={e => setEscalationTarget(e.target.value)} style={inputStyle} placeholder="all" />
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Messaggio escalation</span>
              <input value={escalationMessage} onChange={e => setEscalationMessage(e.target.value)} style={inputStyle} placeholder="Incident non risolto dopo N minuti" />
            </label>
          </>
        )}

        {/* SLA warning conditional fields */}
        {isSlaWarning && (
          <>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Soglia avviso SLA (%)</span>
              <input type="number" min={1} max={100} value={slaThreshold} onChange={e => setSlaThreshold(e.target.value)} style={inputStyle} placeholder="80" />
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>Target avviso SLA</span>
              <input value={slaTarget} onChange={e => setSlaTarget(e.target.value)} style={inputStyle} placeholder="all" />
            </label>
          </>
        )}

        {/* Digest conditional fields */}
        {isDigest && (
          <label style={labelStyle}>
            <span style={labelTextStyle}>Orario digest (HH:MM)</span>
            <input type="time" value={digestTime} onChange={e => setDigestTime(e.target.value)} style={inputStyle} />
          </label>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px', borderRadius: 6, border: '1px solid #e2e8f0',
              fontSize: 'var(--font-size-body)', cursor: 'pointer', background: '#fafafa', color: '#64748b',
            }}
          >
            {t('notificationRules.cancel')}
          </button>
          <button
            onClick={() => onSave({
              eventType, titleKey: titleKey.trim(), severityOverride: severity, channels, target, enabled: true,
              escalationDelayMinutes: isEscalation && escalationDelay ? Number(escalationDelay) : undefined,
              escalationTarget:  isEscalation ? escalationTarget || undefined : undefined,
              escalationMessage: isEscalation ? escalationMessage || undefined : undefined,
              slaWarningThresholdPercent: isSlaWarning && slaThreshold ? Number(slaThreshold) : undefined,
              slaWarningTarget: isSlaWarning ? slaTarget || undefined : undefined,
              digestTime: isDigest ? digestTime || undefined : undefined,
            })}
            disabled={!canSave || saving}
            style={{
              padding: '8px 18px', borderRadius: 6, border: 'none', fontSize: 'var(--font-size-body)', fontWeight: fontWeight.semibold,
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
