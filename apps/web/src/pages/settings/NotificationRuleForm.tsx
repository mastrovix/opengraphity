import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { colors, fontWeight, lookupOrError, alpha, palette } from '@/lib/tokens'
import { WORKFLOW_STEP_PURPOSES } from '@opengraphity/types'
import { SEVERITY_COLOR, CHANNEL_LABEL_KEY, STANDARD_EVENTS, TARGET_OPTIONS, routableFor, type NotificationRouting } from './NotificationRuleList'

/**
 * Un tipo di evento che i workflow del tenant producono davvero
 * (`workflowEventTypes`, D-22). Prima il dialogo offriva solo le costanti di
 * `STANDARD_EVENTS`: chi aveva aggiunto o rinominato un passo doveva scrivere
 * a mano un tipo generato che non poteva indovinare.
 */
export interface WorkflowEventType {
  eventType:    string
  entityType:   string | null
  stepName:     string | null
  stepLabel:    string | null
  stepPurpose:  string | null
  stepCategory: string | null
  stable:       boolean
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateInput {
  eventType:        string
  enabled:          boolean
  severityOverride: string
  titleKey:         string
  channels:         string[]
  target:           string
  /** Restringimento per i soli tipi `<entità>.step_entered`: scopo / categoria del passo. */
  stepPurpose?:                string | null
  stepCategory?:               string | null
  escalationDelayMinutes?:     number | null
  escalationTarget?:           string | null
  escalationMessage?:          string | null
  slaWarningThresholdPercent?: number | null
  slaWarningTarget?:           string | null
  digestTime?:                 string | null
  digestRecipients?:           string[] | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEVERITY_OPTIONS = ['info', 'success', 'warning', 'error'] as const

const CUSTOM_SENTINEL = '__custom__'

// ── NewRuleDialog ─────────────────────────────────────────────────────────────

export function NewRuleDialog({
  routing,
  workflowEventTypes,
  onSave,
  onClose,
  saving,
}: {
  /** Canali consegnabili per tipo di evento (dal server): il dialogo offre solo quelli. */
  routing: NotificationRouting
  /** I tipi di evento veri dei workflow del tenant (dal server). */
  workflowEventTypes: readonly WorkflowEventType[]
  onSave:  (input: CreateInput) => void
  onClose: () => void
  saving:  boolean
}) {
  const { t } = useTranslation()
  const titleId = useId()
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
  // Restringimento della regola di passo (solo per i tipi `*.step_entered`)
  const [stepPurpose,     setStepPurpose]        = useState('')
  const [stepCategory,    setStepCategory]       = useState('')

  const isCustom          = eventTypeSelect === CUSTOM_SENTINEL
  const eventType         = isCustom ? customEventType.trim() : eventTypeSelect
  const isEscalation      = eventType === 'incident.escalation'
  const isSlaWarning      = eventType === 'sla.warning'
  const isDigest          = eventType === 'digest.daily'
  // Tipo stabile di ingresso in un passo: è l'unico che accetta un
  // restringimento per scopo o categoria del passo (il server rifiuta il
  // restringimento su ogni altro tipo, dove non verrebbe applicato).
  const isStepEntered     = workflowEventTypes.some((e) => e.eventType === eventType && e.stable)
  // Le categorie di passo che il tenant usa davvero: derivate dai suoi passi,
  // non da una lista scritta a mano.
  const stepCategories    = [...new Set(workflowEventTypes.map((e) => e.stepCategory).filter((c): c is string => !!c))].sort()
  // I tipi dei workflow non ancora fra le costanti: sono i passi del cliente.
  const workflowOnly      = workflowEventTypes.filter((e) => !STANDARD_EVENTS.includes(e.eventType))
  // Canali offerti per il tipo scelto (i predefiniti finché non c'è un tipo);
  // un canale spuntato che il nuovo tipo non ammette non viene inviato.
  const routable          = routableFor(routing, eventType)
  const chosenChannels    = channels.filter((c) => routable.includes(c))
  const canSave           = !!eventType && !!titleKey.trim() && chosenChannels.length > 0

  const toggleCh = (ch: string) =>
    setChannels((prev) => prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch])

  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', border: `1px solid ${colors.border}`, borderRadius: 6,
    fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', background: palette.neutral.surface1, width: '100%', boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 5,
  }

  const labelTextStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-table)', fontWeight: fontWeight.semibold, color: 'var(--color-slate-light)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  }

  return (
    // Backdrop: il click fuori dal pannello chiude il dialogo (scorciatoia solo-mouse;
    // da tastiera si usa il bottone "Chiudi" nell'header). Stesso pattern di components/Modal.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- overlay: chiusura via mouse, bottone Chiudi per la tastiera
    <div
      style={{
        position: 'fixed', inset: 0, background: alpha.scrim,
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          background: colors.white, borderRadius: 12, padding: 28, width: 480,
          boxShadow: `0 8px 40px ${alpha.black20}`, display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span id={titleId} style={{ fontSize: 'var(--font-size-section-title)', fontWeight: fontWeight.bold, color: 'var(--color-slate-dark)' }}>
            {t('notificationRules.addRule')}
          </span>
          <button type="button" onClick={onClose} aria-label={t('common.close')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 0 }}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Event type */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.eventType')}</span>
          <select value={eventTypeSelect} onChange={(e) => setEventTypeSelect(e.target.value)} style={inputStyle}>
            <option value="">— {t('common.select', 'Seleziona')} —</option>
            <optgroup label={t('notificationRules.eventGroupStandard')}>
              {STANDARD_EVENTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </optgroup>
            {workflowOnly.length > 0 && (
              <optgroup label={t('notificationRules.eventGroupWorkflow')}>
                {workflowOnly.map((e) => (
                  <option key={e.eventType} value={e.eventType}>
                    {e.stepLabel ? `${e.eventType} — ${e.stepLabel}` : e.eventType}
                  </option>
                ))}
              </optgroup>
            )}
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
              // eslint-disable-next-line jsx-a11y/no-autofocus -- campo montato quando l'utente sceglie "evento custom": il focus segue la scelta
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
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ ...inputStyle, color: lookupOrError(SEVERITY_COLOR, severity, 'SEVERITY_COLOR', 'var(--color-slate)'), fontWeight: fontWeight.medium }}>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s} style={{ color: SEVERITY_COLOR[s] }}>{t(`notificationRules.severity.${s}`)}</option>
            ))}
          </select>
        </label>

        {/* Channels: only the ones the dispatcher can route for the chosen event type */}
        <div style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.header.channels')}</span>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {routable.map((value) => (
              <label key={value} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                <input
                  type="checkbox"
                  checked={channels.includes(value)}
                  onChange={() => toggleCh(value)}
                  style={{ accentColor: colors.brand, width: 14, height: 14 }}
                />
                {CHANNEL_LABEL_KEY[value] ? t(CHANNEL_LABEL_KEY[value]) : value}
              </label>
            ))}
          </div>
          <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('notificationRules.routableHint')}</span>
        </div>

        {/* Target */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.header.target')}</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...inputStyle, color: 'var(--color-slate)' }}>
            {TARGET_OPTIONS.map(({ value, labelKey }) => (
              <option key={value} value={value}>{t(labelKey)}</option>
            ))}
          </select>
        </label>

        {/* Restringimento della regola di passo: scopo (vocabolario chiuso) o
            categoria (quelle che il tenant usa). Senza restringimento la regola
            vale per OGNI ingresso in un passo — legittimo, ed è così che una
            regola regge alla rinomina di un passo. */}
        {isStepEntered && (
          <>
            <label style={labelStyle}>
              <span style={labelTextStyle}>{t('notificationRules.stepPurpose')}</span>
              <select value={stepPurpose} onChange={(e) => { setStepPurpose(e.target.value); if (e.target.value) setStepCategory('') }} style={inputStyle}>
                <option value="">{t('notificationRules.stepNarrowingAny')}</option>
                {WORKFLOW_STEP_PURPOSES.map((p) => (
                  <option key={p} value={p}>{t(`workflow.purposeOption.${p}`)}</option>
                ))}
              </select>
            </label>
            {!stepPurpose && (
              <label style={labelStyle}>
                <span style={labelTextStyle}>{t('notificationRules.stepCategory')}</span>
                <select value={stepCategory} onChange={(e) => setStepCategory(e.target.value)} style={inputStyle}>
                  <option value="">{t('notificationRules.stepNarrowingAny')}</option>
                  {stepCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('notificationRules.stepNarrowingHint')}</span>
          </>
        )}

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
          <button type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px', borderRadius: 6, border: `1px solid ${colors.border}`,
              fontSize: 'var(--font-size-body)', cursor: 'pointer', background: palette.neutral.surface1, color: 'var(--color-slate)',
            }}
          >
            {t('notificationRules.cancel')}
          </button>
          <button type="button"
            onClick={() => onSave({
              eventType, titleKey: titleKey.trim(), severityOverride: severity, channels: chosenChannels, target, enabled: true,
              stepPurpose:  isStepEntered ? stepPurpose  || undefined : undefined,
              stepCategory: isStepEntered && !stepPurpose ? stepCategory || undefined : undefined,
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
              background: canSave && !saving ? colors.brand : colors.border,
              color: canSave && !saving ? colors.white : 'var(--color-slate-light)',
            }}
          >
            {saving ? '…' : t('notificationRules.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
