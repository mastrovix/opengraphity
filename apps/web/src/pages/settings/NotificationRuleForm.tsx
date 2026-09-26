import { Input, Select } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { Modal } from '@/components/Modal'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { colors, fontWeight } from '@/lib/tokens'
import { WORKFLOW_STEP_PURPOSES, NOTIFICATION_SEVERITIES } from '@opengraphity/types'
import { SEVERITY_COLOR, CHANNEL_LABEL_KEY, STANDARD_EVENTS, useTargetOptions, withCurrent, routableFor, type NotificationRouting } from './NotificationRuleList'

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

/** Dal vocabolario condiviso con la validazione dell'API (NT-1). */
const SEVERITY_OPTIONS = NOTIFICATION_SEVERITIES

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
  const targetOptions = useTargetOptions()
  const [eventTypeSelect, setEventTypeSelect]   = useState('')
  const [customEventType, setCustomEventType]   = useState('')
  const [titleKey,         setTitleKey]          = useState('')
  const [severity,         setSeverity]          = useState<string>('info')
  const [channels,         setChannels]          = useState<string[]>(['in_app'])
  const [target,           setTarget]            = useState('all')
  // Escalation fields
  const [escalationDelay,   setEscalationDelay]  = useState('')
  const [escalationMessage, setEscalationMessage]= useState('')
  // SLA warning fields
  // Digest fields
  const [digestTime,       setDigestTime]        = useState('08:00')
  // Restringimento della regola di passo (solo per i tipi `*.step_entered`)
  const [stepPurpose,     setStepPurpose]        = useState('')
  const [stepCategory,    setStepCategory]       = useState('')

  const isCustom          = eventTypeSelect === CUSTOM_SENTINEL
  const eventType         = isCustom ? customEventType.trim() : eventTypeSelect
  const isEscalation      = eventType === 'incident.escalation'
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


  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 5,
  }

  const labelTextStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-table)', fontWeight: fontWeight.semibold, color: 'var(--color-slate-light)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  }

  // The app's `Modal` (26 Sep 2026: this dialog drew its own overlay and header).
  return (
    <Modal
      open
      onClose={onClose}
      title={t('notificationRules.addRule')}
      zIndex={200}
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('notificationRules.cancel')}
          </Button>
          <Button
            onClick={() => onSave({
              eventType, titleKey: titleKey.trim(), severityOverride: severity, channels: chosenChannels, target, enabled: true,
              stepPurpose:  isStepEntered ? stepPurpose  || undefined : undefined,
              stepCategory: isStepEntered && !stepPurpose ? stepCategory || undefined : undefined,
              escalationDelayMinutes: isEscalation && escalationDelay ? Number(escalationDelay) : undefined,
              escalationMessage: isEscalation ? escalationMessage || undefined : undefined,
              digestTime: isDigest ? digestTime || undefined : undefined,
            })}
            disabled={!canSave || saving}
          >
            {saving ? '…' : t('notificationRules.save')}
          </Button>
        </>
      }
    >
        {/* Event type */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.eventType')}</span>
          <Select value={eventTypeSelect} onChange={(e) => setEventTypeSelect(e.target.value)}>
            <option value="">— {t('common.select')} —</option>
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
          </Select>
        </label>

        {isCustom && (
          <label style={labelStyle}>
            <span style={labelTextStyle}>{t('notificationRules.customEventType')}</span>
            <Input
              value={customEventType}
              onChange={(e) => setCustomEventType(e.target.value)}
              placeholder={t('notificationRules.customEventPlaceholder')}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- campo montato quando l'utente sceglie "evento custom": il focus segue la scelta
              autoFocus
            />
          </label>
        )}

        {/* Title key */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.titleKey')}</span>
          <Input
            value={titleKey}
            onChange={(e) => setTitleKey(e.target.value)}
            placeholder={t('notificationRules.titleKeyPlaceholder')}
          />
        </label>

        {/* Severity */}
        <label style={labelStyle}>
          <span style={labelTextStyle}>{t('notificationRules.header.severity')}</span>
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ fontWeight: fontWeight.medium }}>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s} style={{ color: SEVERITY_COLOR[s] }}>{t(`notificationRules.severity.${s}`)}</option>
            ))}
          </Select>
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
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            {withCurrent(targetOptions, target).map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </label>

        {/* Restringimento della regola di passo: scopo (vocabolario chiuso) o
            categoria (quelle che il tenant usa). Senza restringimento la regola
            vale per OGNI ingresso in un passo — legittimo, ed è così che una
            regola regge alla rinomina di un passo. */}
        {isStepEntered && (
          <>
            <label style={labelStyle}>
              <span style={labelTextStyle}>{t('notificationRules.stepPurpose')}</span>
              <Select value={stepPurpose} onChange={(e) => { setStepPurpose(e.target.value); if (e.target.value) setStepCategory('') }}>
                <option value="">{t('notificationRules.stepNarrowingAny')}</option>
                {WORKFLOW_STEP_PURPOSES.map((p) => (
                  <option key={p} value={p}>{t(`workflow.purposeOption.${p}`)}</option>
                ))}
              </Select>
            </label>
            {!stepPurpose && (
              <label style={labelStyle}>
                <span style={labelTextStyle}>{t('notificationRules.stepCategory')}</span>
                <Select value={stepCategory} onChange={(e) => setStepCategory(e.target.value)}>
                  <option value="">{t('notificationRules.stepNarrowingAny')}</option>
                  {stepCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </label>
            )}
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('notificationRules.stepNarrowingHint')}</span>
          </>
        )}

        {/* Escalation conditional fields */}
        {isEscalation && (
          <>
            <label style={labelStyle}>
              <span style={labelTextStyle}>{t('notificationRules.escalationDelay')}</span>
              <Input type="number" min={1} value={escalationDelay} onChange={e => setEscalationDelay(e.target.value)} placeholder="30" />
            </label>
            <label style={labelStyle}>
              <span style={labelTextStyle}>{t('notificationRules.escalationMessage')}</span>
              <Input value={escalationMessage} onChange={e => setEscalationMessage(e.target.value)} placeholder={t('notificationRules.escalationMessagePlaceholder')} />
            </label>
          </>
        )}

        {/* Digest conditional fields */}
        {isDigest && (
          <label style={labelStyle}>
            <span style={labelTextStyle}>{t('notificationRules.digestTime')}</span>
            <Input type="time" value={digestTime} onChange={e => setDigestTime(e.target.value)} />
          </label>
        )}

    </Modal>
  )
}
