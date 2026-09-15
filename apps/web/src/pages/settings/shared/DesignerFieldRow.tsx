import { Lock, Trash2 } from 'lucide-react'
import { btnSecondary, btnDanger } from './designerStyles'
import { colors } from '../../../lib/tokens'

export interface FieldRowData {
  id:           string
  name:         string
  label:        string
  fieldType:    string
  required:     boolean
  isSystem:     boolean
  enumValues?:  string[]
  enumTypeName?: string | null
}

interface DesignerFieldRowProps {
  field:            FieldRowData
  onEdit:           () => void
  onDelete:         () => void
  editLabel?:       string
  systemFieldLabel?: string
  /**
   * Al posto dei valori del vocabolario: da dove vengono DAVVERO i valori del
   * campo. Giro UI del 15 set 2026 · U-13: lo «Status» delle richieste elencava
   * il vocabolario `status_service_request`, mentre lo stato di un ticket è il
   * passo del suo workflow.
   */
  valuesNote?:      string
}

export function DesignerFieldRow({
  field,
  onEdit,
  onDelete,
  editLabel = 'Edit',
  systemFieldLabel = 'System field',
  valuesNote,
}: DesignerFieldRowProps) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', background: colors.white, border: '1px solid var(--border)',
        borderRadius: 6, marginBottom: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
        {field.isSystem ? (
          <span title={systemFieldLabel}>
            <Lock size={12} color={colors.slateLight} style={{ flexShrink: 0 }} />
          </span>
        ) : (
          <div style={{ width: 12 }} />
        )}
        <div>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>
            {field.label}
            <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginLeft: 6, fontWeight: 400 }}>
              {field.name}
            </span>
          </div>
          <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 1 }}>
            {field.fieldType}
            {field.required && (
              <span style={{ marginLeft: 6, color: 'var(--color-danger)' }}>required</span>
            )}
            {valuesNote !== undefined && (
              <span style={{ marginLeft: 6 }} data-testid="field-values-note">{valuesNote}</span>
            )}
            {valuesNote === undefined && field.fieldType === 'enum' && field.enumValues && field.enumValues.length > 0 && (
              <span style={{ marginLeft: 6 }}>[{field.enumValues.join(', ')}]</span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={btnSecondary} onClick={onEdit}>{editLabel}</button>
        {!field.isSystem && (
          <button type="button" style={btnDanger} onClick={onDelete} aria-label={`Delete ${field.name}`}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
