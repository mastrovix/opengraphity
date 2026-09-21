import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/hooks/useConfirm'
import { toast } from 'sonner'
import type { WFTransition, PendingTransitionChange } from './workflow-types'
import { panelStyle, panelInputStyle, saveButtonStyle, PanelHeader, PanelField } from './workflow-panel-helpers'
import { Input, Select } from '@/components/ui/FormControls'
import { colors } from '@/lib/tokens'
import { WORKFLOW_TRANSITION_TRIGGERS, WORKFLOW_TRANSITION_CONDITIONS } from '@opengraphity/types'

const inputStyle = panelInputStyle

interface EdgePanelProps {
  transition:    WFTransition
  onClose:       () => void
  onSaved:       (updated: Partial<WFTransition>) => void
  onSaveLocally: (change: PendingTransitionChange) => void
  onDelete?:     (transitionId: string) => void
}

export function WorkflowTransitionPanel({ transition, onClose, onSaved, onSaveLocally, onDelete }: EdgePanelProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [label,         setLabel]         = useState(transition.label)
  const [trigger,       setTrigger]       = useState(transition.trigger)
  const [requiresInput, setRequiresInput] = useState(transition.requiresInput)
  const [inputField,    setInputField]    = useState(transition.inputField ?? '')
  const [condition,     setCondition]     = useState(transition.condition ?? '')
  const [timerHours,    setTimerHours]    = useState<string>(transition.timerHours != null ? String(transition.timerHours) : '')

  const unchanged =
    label         === transition.label         &&
    trigger       === transition.trigger       &&
    requiresInput === transition.requiresInput &&
    (inputField  || null) === transition.inputField &&
    (condition   || null) === transition.condition  &&
    (timerHours ? parseInt(timerHours, 10) : null) === transition.timerHours

  return (
    <div style={panelStyle}>
      <PanelHeader title={t('pages.workflowStep.editTransition')} onClose={onClose} />

      <PanelField label={t('workflow.panel.from_to')}>
        <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          <code>{transition.fromStepName}</code> → <code>{transition.toStepName}</code>
        </span>
      </PanelField>

      <PanelField label={t('workflow.panel.label')}>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
      </PanelField>

      <PanelField label={t('workflow.panel.trigger')}>
        <Select value={trigger} onChange={(e) => setTrigger(e.target.value)} style={inputStyle}>
          {WORKFLOW_TRANSITION_TRIGGERS.map((tr) => (
            <option key={tr} value={tr}>{tr}</option>
          ))}
        </Select>
        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', lineHeight: 1.4 }}>
          {t('workflow.triggerHint')}
        </span>
      </PanelField>

      <PanelField label={t('workflow.panel.richiede_input')}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={requiresInput}
            onChange={(e) => { setRequiresInput(e.target.checked); if (!e.target.checked) setInputField('') }}
          />
          <span style={{ fontSize: 'var(--font-size-body)' }}>{requiresInput ? 'Sì' : 'No'}</span>
        </label>
      </PanelField>

      {requiresInput && (
        <PanelField label={t('workflow.panel.inputField')}>
          <Select value={inputField} onChange={(e) => setInputField(e.target.value)} style={inputStyle}>
            <option value="">{t('pages.workflowStep.noneMasculine')}</option>
            <option value="rootCause">rootCause</option>
            <option value="notes">notes</option>
          </Select>
        </PanelField>
      )}

      {/* Revisione · B·M-4. Era un campo di testo con un segnaposto su un
          registro CHIUSO di cinque condizioni: un refuso
          (`all_assessment_complete`) si salvava senza un fiato e trasformava
          quell'arco in un muro — il motore lo rifiuta a ogni tentativo e il
          ticket non si muove più. Stessa forma dello scopo e della categoria. */}
      <PanelField label={t('workflow.conditionLabel')}>
        <Select value={condition} onChange={(e) => setCondition(e.target.value)} style={inputStyle}>
          <option value="">{t('workflow.conditionNone')}</option>
          {WORKFLOW_TRANSITION_CONDITIONS.map((c) => (
            <option key={c} value={c}>{t(`workflow.conditionOption.${c}`)}</option>
          ))}
        </Select>
        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', lineHeight: 1.4 }}>
          {t('workflow.conditionHint')}
        </span>
        {/*
          UNA GUARDIA SU UN ARCO DI SISTEMA non si comporta come su uno
          manuale: nessuno la vede fallire. Il prodotto ora non perde più
          niente — l'escalation rifiutata lascia una nota sul ticket e
          l'attesa un rilievo in Diagnostica — ma resta il fatto che il
          ticket NON si muove finché qualcuno non chiude quello che manca.
          Chi disegna deve saperlo mentre lo sceglie, non dopo.
        */}
        {condition !== '' && (trigger === 'sla_breach' || trigger === 'timer') && (
          <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-warning-text)', lineHeight: 1.4 }}>
            {t('workflow.conditionOnSystemTrigger')}
          </span>
        )}
      </PanelField>

      {trigger === 'timer' && (
        <PanelField label={t('workflow.panel.timer_ore')}>
          <Input
            type="number"
            min={1}
            value={timerHours}
            onChange={(e) => setTimerHours(e.target.value)}
            placeholder="ore"
            style={inputStyle}
          />
        </PanelField>
      )}

      <button
        type="button"
        onClick={() => {
          const change: PendingTransitionChange = {
            transitionId:  transition.id,
            label,
            trigger,
            requiresInput,
            inputField:  inputField  || null,
            condition:   condition   || null,
            timerHours:  timerHours  ? parseInt(timerHours, 10) : null,
          }
          onSaveLocally(change)
          onSaved({ label, trigger, requiresInput, inputField: change.inputField, condition: change.condition, timerHours: change.timerHours })
          toast.success(t('toast.workflow.savedLocally'))
        }}
        disabled={unchanged}
        style={saveButtonStyle(unchanged)}
      >
        {t('common.save')}
      </button>

      {onDelete && (
        <button
          type="button"
          onClick={() => {
            void confirm({ title: t('workflow.panel.deleteTransitionTitle', { from: transition.fromStepName, to: transition.toStepName }), danger: true }).then((ok) => {
              if (ok) onDelete(transition.id)
            })
          }}
          style={{
            marginTop: 8, width: '100%', padding: '8px 12px', borderRadius: 6,
            border: '1px solid var(--color-danger)', background: colors.white,
            color: 'var(--color-danger)', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600,
          }}
        >
          {t('pages.workflow.deleteTransition')}
        </button>
      )}
    </div>
  )
}
