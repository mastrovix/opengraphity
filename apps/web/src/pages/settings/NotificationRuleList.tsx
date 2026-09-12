import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, Lock, Unlock, AlertTriangle } from 'lucide-react'
import { NOTIFICATION_TARGETS } from '@opengraphity/types'
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
  defaultTargets: string[]
  targetsByEventType: Array<{ eventType: string; targets: string[] }>
}

export function routableFor(routing: NotificationRouting, eventType: string): string[] {
  return routing.byEventType.find((e) => e.eventType === eventType)?.channels ?? routing.defaultChannels
}

/**
 * I bersagli che hanno senso per quel tipo di evento. Alla nascita di un
 * ticket non esistono ancora assegnatario e team, quindi offrirli sarebbe
 * offrire una regola che non consegnerà mai niente: il server la rifiuta, e
 * qui non la proponiamo nemmeno. Un bersaglio già salvato ma non più
 * applicabile resta visibile (con l'avviso) perché si possa cambiare.
 */
export function targetsFor(routing: NotificationRouting, eventType: string): string[] {
  return routing.targetsByEventType.find((e) => e.eventType === eventType)?.targets ?? routing.defaultTargets
}

/** Le opzioni della tendina per quell'evento, più il valore salvato se non è più fra quelli applicabili. */
export function targetOptionsFor(routing: NotificationRouting, eventType: string, current: string): { value: string; labelKey: string; applicable: boolean }[] {
  const applicable = targetsFor(routing, eventType)
  const options = TARGET_OPTIONS.filter((o) => applicable.includes(o.value)).map((o) => ({ ...o, applicable: true }))
  if (!applicable.includes(current)) {
    const saved = TARGET_OPTIONS.find((o) => o.value === current)
    if (saved) options.unshift({ ...saved, applicable: false })
  }
  return options
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
      // Il tipo STABILE dell'ingresso in un passo (D-22) prende il posto di
      // `incident.on_hold`, che nessun evento produceva: il passo di attesa di
      // fabbrica si chiama `pending`. Una regola su questo tipo può essere
      // ristretta allo scopo o alla categoria del passo, e regge alla rinomina.
      'incident.step_entered',
      'incident.escalated', 'incident.resolved', 'incident.closed',
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
      'problem.created', 'problem.step_entered', 'problem.under_investigation', 'problem.deferred',
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

/**
 * Etichette dei destinatari. QUALI destinatari esistono lo dice il
 * vocabolario condiviso `NOTIFICATION_TARGETS` (@opengraphity/types): la
 * stessa lista che il resolver valida in scrittura e che il dispatcher sa
 * risolvere, con un bersaglio per ruolo derivato da `USER_ROLES`. Prima qui
 * c'era una lista scritta a mano che offriva `role:manager` — un ruolo che
 * l'autenticazione non conosce, quindi zero destinatari (D-13/D-23).
 * Un bersaglio del vocabolario senza etichetta qui è un errore al caricamento
 * del modulo (lo prende il test): mai un'opzione muta in tendina.
 */
const TARGET_LABEL_KEY: Record<string, string> = {
  'all':            'notificationRules.target.all',
  'assignee':       'notificationRules.target.assignee',
  'team_owner':     'notificationRules.target.teamOwner',
  'role:admin':     'notificationRules.target.roleAdmin',
  'role:operator':  'notificationRules.target.roleOperator',
  'role:viewer':    'notificationRules.target.roleViewer',
  'role:end_user':  'notificationRules.target.roleEndUser',
}

export const TARGET_OPTIONS: { value: string; labelKey: string }[] = NOTIFICATION_TARGETS.map((value) => {
  const labelKey = TARGET_LABEL_KEY[value]
  if (!labelKey) throw new Error(`TARGET_LABEL_KEY: manca l'etichetta del destinatario "${value}" — aggiungi la chiave e le traduzioni it/en prima di offrirlo`)
  return { value, labelKey }
})

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
  /** Restringimento della regola sul tipo stabile del passo: scopo / categoria. */
  stepPurpose?:     string | null
  stepCategory?:    string | null
  /**
   * Falso = niente, nel prodotto o nei workflow di questo tenant, produce il
   * tipo di evento della regola: la regola è accesa e non scatterà mai. Prima
   * non risultava da nessuna parte (il dispatcher usciva in silenzio).
   */
  eventProduced?:   boolean
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
  targets,
  onUpdate,
  onDelete,
}: {
  rule:     NotificationRule
  /** Canali consegnabili per `rule.eventType` (dal server). */
  routable: readonly string[]
  /** Bersagli applicabili a `rule.eventType`, col valore salvato in testa se non lo è più (dal server). */
  targets:  readonly { value: string; labelKey: string; applicable: boolean }[]
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
          {/* Regola che non scatterà mai: nessun evento di questo tipo viene
              prodotto. Era il caso di `incident.on_hold`, viva in ogni tenant e
              morta da sempre, e non si vedeva da nessuna parte (D-22/B-16). */}
          {rule.eventProduced === false && (
            <span title={t('notificationRules.eventNotProduced', { eventType: rule.eventType })} style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--color-danger)' }}>
              <AlertTriangle size={14} aria-label={t('notificationRules.eventNotProduced', { eventType: rule.eventType })} />
            </span>
          )}
        </div>
        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', fontFamily: 'monospace', marginTop: 1 }}>{rule.eventType}</div>
        {/* Restringimento della regola del passo: si imposta alla creazione ed
            è ciò che la rende riconoscibile senza nominare un passo. */}
        {(rule.stepPurpose || rule.stepCategory) && (
          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 1 }}>
            {rule.stepPurpose
              ? t('notificationRules.narrowPurpose', { purpose: t(`workflow.purposeOption.${rule.stepPurpose}`) })
              : t('notificationRules.narrowCategory', { category: rule.stepCategory })}
          </div>
        )}
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
          {targets.map(({ value, labelKey, applicable }) => (
            <option key={value} value={value}>
              {applicable ? t(labelKey) : t('notificationRules.target.notApplicable', { target: t(labelKey) })}
            </option>
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
