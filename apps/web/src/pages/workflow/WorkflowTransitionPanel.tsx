import { useState } from 'react'
import { toast } from 'sonner'
import type { WFTransition, PendingTransitionChange } from './workflow-types'
import { panelStyle, panelInputStyle, saveButtonStyle, PanelHeader, PanelField } from './workflow-panel-helpers'

const inputStyle = panelInputStyle

interface EdgePanelProps {
  transition:    WFTransition
  onClose:       () => void
  onSaved:       (updated: Partial<WFTransition>) => void
  onSaveLocally: (change: PendingTransitionChange) => void
}

export function WorkflowTransitionPanel({ transition, onClose, onSaved, onSaveLocally }: EdgePanelProps) {
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
      <PanelHeader title="Modifica Transizione" onClose={onClose} />

      <PanelField label="From → To">
        <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>
          <code>{transition.fromStepName}</code> → <code>{transition.toStepName}</code>
        </span>
      </PanelField>

      <PanelField label="Label">
        <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
      </PanelField>

      <PanelField label="Trigger">
        <select value={trigger} onChange={(e) => setTrigger(e.target.value)} style={inputStyle}>
          <option value="manual">manual</option>
          <option value="automatic">automatic</option>
          <option value="timer">timer</option>
          <option value="sla_breach">sla_breach</option>
        </select>
      </PanelField>

      <PanelField label="Richiede Input">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={requiresInput}
            onChange={(e) => { setRequiresInput(e.target.checked); if (!e.target.checked) setInputField('') }}
          />
          <span style={{ fontSize: 14 }}>{requiresInput ? 'Sì' : 'No'}</span>
        </label>
      </PanelField>

      {requiresInput && (
        <PanelField label="Campo Input">
          <select value={inputField} onChange={(e) => setInputField(e.target.value)} style={inputStyle}>
            <option value="">— nessuno —</option>
            <option value="rootCause">rootCause</option>
            <option value="notes">notes</option>
          </select>
        </PanelField>
      )}

      <PanelField label="Condizione (opzionale)">
        <input
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          placeholder="es. has_linked_change"
          style={inputStyle}
        />
      </PanelField>

      {trigger === 'timer' && (
        <PanelField label="Timer (ore)">
          <input
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
          toast.success('Modifica salvata localmente')
        }}
        disabled={unchanged}
        style={saveButtonStyle(unchanged)}
      >
        Salva
      </button>
    </div>
  )
}
