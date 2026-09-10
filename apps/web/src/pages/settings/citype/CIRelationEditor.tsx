import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Input, Select } from '@/components/ui/FormControls'
import { inputS, selectS, labelS, btnPrimary, btnSecondary, btnDanger } from '@/components/ui/styles'
import { useConfirm } from '@/hooks/useConfirm'
import type { CITypeDef, CIRelationDef } from '@/contexts/MetamodelContext'
import { palette } from '@/lib/tokens'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelS}>{label}</label>
      {children}
    </div>
  )
}

// ── RelationModal ─────────────────────────────────────────────────────────────

export interface RelationForm {
  name: string; label: string; relationshipType: string
  targetType: string; cardinality: string; direction: string; order: number
}

export const emptyRelForm = (): RelationForm => ({
  name: '', label: '', relationshipType: 'DEPENDS_ON',
  targetType: 'any', cardinality: 'many', direction: 'outgoing', order: 0,
})

interface RelationModalProps {
  open: boolean
  onClose: () => void
  onSave: (form: RelationForm) => Promise<void>
  allTypes: CITypeDef[]
}

export function CIRelationEditor({ open, onClose, onSave, allTypes }: RelationModalProps) {
  const [form, setForm] = useState<RelationForm>(emptyRelForm())
  const [saving, setSaving] = useState(false)
  const set = (k: keyof RelationForm, v: unknown) => setForm(p => ({ ...p, [k]: v }))

  return (
    <Modal open={open} onClose={onClose} title="Aggiungi relazione CI" width={500}
      footer={
        <>
          <button type="button" style={btnSecondary} onClick={onClose}>Annulla</button>
          <button type="button" style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}
            onClick={async () => {
              setSaving(true)
              try { await onSave(form) } finally { setSaving(false) }
            }}>
            {saving ? 'Salvataggio…' : 'Salva'}
          </button>
        </>
      }>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        <Field label="name (slug) *">
          <Input style={inputS} value={form.name}
            onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label="label *">
          <Input style={inputS} value={form.label} onChange={e => set('label', e.target.value)} />
        </Field>
        <Field label="Tipo relazione Neo4j *">
          <Input style={inputS} value={form.relationshipType}
            onChange={e => set('relationshipType', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="DEPENDS_ON" />
        </Field>
        <Field label="Tipo target">
          <Select style={selectS} value={form.targetType} onChange={e => set('targetType', e.target.value)}>
            <option value="any">qualsiasi</option>
            {allTypes.map(t => <option key={t.name} value={t.name}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label="Cardinalità">
          <Select style={selectS} value={form.cardinality} onChange={e => set('cardinality', e.target.value)}>
            <option value="one">one</option>
            <option value="many">many</option>
          </Select>
        </Field>
        <Field label="Direzione">
          <Select style={selectS} value={form.direction} onChange={e => set('direction', e.target.value)}>
            <option value="outgoing">outgoing</option>
            <option value="incoming">incoming</option>
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

// ── RelationTable ─────────────────────────────────────────────────────────────

interface RelationTableProps {
  relations: CIRelationDef[]
  onRemove: (r: CIRelationDef) => void
}

export function CIRelationTable({ relations, onRemove }: RelationTableProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const handleRemove = async (r: CIRelationDef) => {
    if (await confirm({ title: t('ciTypeDesigner.deleteRelationTitle', { name: r.name }), danger: true })) onRemove(r)
  }
  if (relations.length === 0) {
    return <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Nessuna relazione CI configurata.</p>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
      <thead>
        <tr style={{ borderBottom: '2px solid var(--border)' }}>
          {['name', 'label', 'tipo Neo4j', 'target', 'card.', 'dir.', ''].map(h => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...relations].sort((a: CIRelationDef, b: CIRelationDef) => a.order - b.order).map(r => (
          <tr key={r.id} style={{ borderBottom: `1px solid ${palette.neutral.borderLight}` }}>
            <td style={{ padding: '8px', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 'var(--font-size-body)' }}>{r.name}</td>
            <td style={{ padding: '8px' }}>{r.label}</td>
            <td style={{ padding: '8px', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 'var(--font-size-body)' }}>{r.relationshipType}</td>
            <td style={{ padding: '8px', fontSize: 'var(--font-size-body)' }}>{r.targetType}</td>
            <td style={{ padding: '8px', fontSize: 'var(--font-size-body)' }}>{r.cardinality}</td>
            <td style={{ padding: '8px', fontSize: 'var(--font-size-body)' }}>{r.direction}</td>
            <td style={{ padding: '8px' }}>
              <button type="button" style={{ ...btnDanger, padding: '3px 10px' }}
                aria-label={`Elimina relazione ${r.name}`}
                onClick={() => void handleRemove(r)}>
                <X size={12} aria-hidden="true" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
