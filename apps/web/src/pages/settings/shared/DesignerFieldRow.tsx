import { Lock, Trash2 } from 'lucide-react'
import { btnSecondary, btnDanger } from './designerStyles'

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
}

export function DesignerFieldRow({
  field,
  onEdit,
  onDelete,
  editLabel = 'Edit',
  systemFieldLabel = 'System field',
}: DesignerFieldRowProps) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', background: '#fff', border: '1px solid #e5e7eb',
        borderRadius: 6, marginBottom: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
        {field.isSystem ? (
          <span title={systemFieldLabel}>
            <Lock size={12} color="#94a3b8" style={{ flexShrink: 0 }} />
          </span>
        ) : (
          <div style={{ width: 12 }} />
        )}
        <div>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)' }}>
            {field.label}
            <span style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', marginLeft: 6, fontWeight: 400 }}>
              {field.name}
            </span>
          </div>
          <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8', marginTop: 1 }}>
            {field.fieldType}
            {field.required && (
              <span style={{ marginLeft: 6, color: '#ef4444' }}>required</span>
            )}
            {field.fieldType === 'enum' && field.enumValues && field.enumValues.length > 0 && (
              <span style={{ marginLeft: 6 }}>[{field.enumValues.join(', ')}]</span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btnSecondary} onClick={onEdit}>{editLabel}</button>
        {!field.isSystem && (
          <button style={btnDanger} onClick={onDelete} aria-label={`Delete ${field.name}`}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
