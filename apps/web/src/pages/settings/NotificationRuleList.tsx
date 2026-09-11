import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Lock, Unlock, AlertTriangle } from 'lucide-react'
import { colors, fontSize, fontWeight, palette } from '@/lib/tokens'
import { Toggle as SharedToggle } from '@/components/ui/Toggle'

// ── Re-exported from NotificationRulesPage ────────────────────────────────────

export const SEVERITY_COLOR: Record<string, string> = {
  info:    'var(--color-trigger-manual)',
  success: palette.success.base,
  warning: palette.warning.base,
  error:   'var(--color-danger)',
}

/** Etichette dei canali; QUALI canali offrire per un evento lo dice il server (`notificationRouting`). */
export const CHANNEL_LABEL_KEY: Record<string, string> = {
  in_app: 'notificationRules.channels.inApp',
  slack:  'notificationRules.channels.slack',
  teams:  'notificationRules.channels.teams',
  email:  'notificationRules.channels.email',
}

/**
 * Tabella `notificationRouting` così come arriva dall'API: i canali che il
 * dispatcher sa consegnare per un tipo di evento (D3.1). `routableFor` è la
 * sola funzione che lista e dialogo usano: nessun nome di evento o di canale
 * è scritto nel web.
 */
export interface NotificationRouting {
  defaultChannels: string[]
  byEventType: Array<{ eventType: string; channels: string[] }>
}

export function routableFor(routing: NotificationRouting, eventType: string): string[] {
  return routing.byEventType.find((e) => e.eventType === eventType)?.channels ?? routing.defaultChannels
}

/**
 * Sezioni della pagina. Le regole seminate per gli allarmi (`event.*`,
 * `ci.*`), i servizi monitorati (`service.*`) e la discovery (`sync.*`,
 * `conflict.*`) hanno la loro sezione: prima finivano tutte sotto
 * «Personalizzate». Ogni regola con un tipo non elencato qui resta custom.
 */
export const RULE_CATEGORIES: { key: string; events: string[] }[] = [
  {
    key: 'incident',
    events: [
      'incident.created', 'incident.assigned', 'incident.in_progress',
      'incident.on_hold', 'incident.escalated', 'incident.resolved', 'incident.closed',
    ],
  },
  {
    key: 'change',
    events: [
      'change.approved', 'change.completed', 'change.failed',
      'change.rejected', 'change.task_assigned',
    ],
  },
  {
    key: 'problem',
    events: [
      'problem.created', 'problem.under_investigation', 'problem.deferred',
      'problem.resolved', 'problem.closed',
    ],
  },
  {
    key: 'sla',
    events: ['sla.warning', 'sla.breached', 'ola.breached'],
  },
  {
    key: 'escalation',
    events: ['incident.escalation'],
  },
  {
    key: 'events',
    events: [
      'event.received', 'event.resolved', 'event.orphan', 'event.suppressed', 'event.correlated',
      'event.flapping', 'event.stable', 'event.storm_started', 'event.storm_ended',
      'ci.health_changed',
    ],
  },
  {
    key: 'services',
    events: ['service.health_changed', 'service.incident_opened'],
  },
  {
    key: 'discovery',
    events: ['sync.completed', 'sync.failed', 'conflict.created'],
  },
  {
    key: 'digest',
    events: ['digest.daily'],
  },
]

export const STANDARD_EVENTS = RULE_CATEGORIES.flatMap((c) => c.events)

const SEVERITY_OPTIONS = ['info', 'success', 'warning', 'error'] as const

const TARGET_OPTIONS: { value: string; labelKey: string }[] = [
  { value: 'all',          labelKey: 'notificationRules.target.all'         },
  { value: 'assignee',     labelKey: 'notificationRules.target.assignee'    },
  { value: 'team_owner',   labelKey: 'notificationRules.target.teamOwner'   },
  { value: 'role:admin',   labelKey: 'notificationRules.target.adminOnly'   },
  { value: 'role:manager', labelKey: 'notificationRules.target.managerOnly' },
]

const selectStyle: React.CSSProperties = {
  padding: '4px 8px', border: `1px solid ${colors.border}`, borderRadius: 4,
  fontSize: 'var(--font-size-body)', background: palette.neutral.surface1, cursor: 'pointer', width: '100%',
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

/** Thin alias over the design-system `Toggle` (E-10): same `value/onChange` API, accessible switch. */
export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <SharedToggle checked={value} onChange={onChange} label={label} />
}

// ── RuleRow ───────────────────────────────────────────────────────────────────

export function RuleRow({
  rule,
  routable,
  onUpdate,
  onDelete,
}: {
  rule:     NotificationRule
  /** Canali consegnabili per `rule.eventType` (dal server). */
  routable: readonly string[]
  onUpdate: (id: string, input: UpdateInput) => void
  onDelete: (id: string) => void
}) {
  const { t } = useTranslation()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // I canali offerti sono quelli instradabili; un canale già salvato ma non
  // instradabile (regola scritta prima della migrazione 1150 o per altre vie)
  // resta visibile con un avviso, così l'amministratore lo può togliere: non
  // sparisce dalla vista mentre continua a far fallire il job di notifica.
  const stale    = rule.channels.filter((c) => !routable.includes(c))
  const options  = [...routable, ...stale]

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
    <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
      {/* Enabled */}
      <td style={{ padding: '10px 12px', width: 52 }}>
        <Toggle value={rule.enabled} onChange={(v) => debounce({ enabled: v })} label={`${t('notificationRules.enabled')}: ${titleLabel}`} />
      </td>

      {/* Event */}
      <td style={{ padding: '10px 12px', fontSize: fontSize.table, color: 'var(--color-slate-dark)', fontWeight: fontWeight.medium }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {titleLabel}
          {rule.isSeed
            ? <span title={t('notificationRules.systemRule',   'Regola di sistema')}     style={{ display: 'inline-flex', flexShrink: 0 }}><Lock   size={14} color={colors.slateLight} /></span>
            : <span title={t('notificationRules.customRule',   'Regola personalizzata')} style={{ display: 'inline-flex', flexShrink: 0 }}><Unlock size={14} color={colors.slateLight} /></span>
          }
        </div>
        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', fontFamily: 'monospace', marginTop: 1 }}>{rule.eventType}</div>
      </td>

      {/* Severity */}
      <td style={{ padding: '10px 12px', width: 120 }}>
        <select
          value={rule.severityOverride}
          onChange={(e) => debounce({ severityOverride: e.target.value })}
          style={{ ...selectStyle, color: SEVERITY_COLOR[rule.severityOverride] ?? 'var(--color-slate)', fontWeight: fontWeight.medium }}
        >
          {SEVERITY_OPTIONS.map((s) => (
            <option key={s} value={s} style={{ color: SEVERITY_COLOR[s] }}>{t(`notificationRules.severity.${s}`)}</option>
          ))}
        </select>
      </td>

      {/* Channels: only the ones the dispatcher can route for this event type */}
      <td style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {options.map((value) => {
            const isStale = stale.includes(value)
            const label   = CHANNEL_LABEL_KEY[value] ? t(CHANNEL_LABEL_KEY[value]) : value
            return (
              <label
                key={value}
                title={isStale ? t('notificationRules.channelNotRoutable', { channel: label }) : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: isStale ? 'var(--color-danger)' : 'var(--color-slate)' }}
              >
                <input
                  type="checkbox"
                  checked={rule.channels.includes(value)}
                  onChange={() => toggleChannel(value)}
                  style={{ accentColor: colors.brand, width: 13, height: 13 }}
                />
                {label}
                {isStale && <AlertTriangle size={12} aria-label={t('notificationRules.channelNotRoutable', { channel: label })} />}
              </label>
            )
          })}
        </div>
      </td>

      {/* Target */}
      <td style={{ padding: '10px 12px', width: 160 }}>
        <select value={rule.target} onChange={(e) => debounce({ target: e.target.value })} style={{ ...selectStyle, color: 'var(--color-slate)' }}>
          {TARGET_OPTIONS.map(({ value, labelKey }) => (
            <option key={value} value={value}>{t(labelKey)}</option>
          ))}
        </select>
      </td>

      {/* Delete (custom rules only) */}
      <td style={{ padding: '10px 8px', width: 36, textAlign: 'center' }}>
        {!rule.isSeed && (
          <button type="button"
            onClick={() => onDelete(rule.id)}
            title={t('notificationRules.deleteRule')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 4,
              color: 'var(--color-slate-light)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-danger)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-slate-light)' }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </td>
    </tr>
  )
}
