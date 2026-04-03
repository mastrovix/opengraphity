import { useState } from 'react'
import { X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import type { CITypeDef, CIRelationDef } from '@/contexts/MetamodelContext'

// ── Style constants ────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 14, color: 'var(--color-slate-dark)', outline: 'none',
  backgroundColor: '#fff', boxSizing: 'border-box',
}

const selectS: React.CSSProperties = {
  ...inputS,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}

const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
}

const btnSecondary: React.CSSProperties = {
  padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 14, cursor: 'pointer',
}

const btnDanger: React.CSSProperties = {
  padding: '6px 12px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: 'var(--color-trigger-sla-breach)', fontSize: 12, cursor: 'pointer',
}

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
          <button style={btnSecondary} onClick={onClose}>Annulla</button>
          <button style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}
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
          <input style={inputS} value={form.name}
            onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label="label *">
          <input style={inputS} value={form.label} onChange={e => set('label', e.target.value)} />
        </Field>
        <Field label="Tipo relazione Neo4j *">
          <input style={inputS} value={form.relationshipType}
            onChange={e => set('relationshipType', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="DEPENDS_ON" />
        </Field>
        <Field label="Tipo target">
          <select style={selectS} value={form.targetType} onChange={e => set('targetType', e.target.value)}>
            <option value="any">qualsiasi</option>
            {allTypes.map(t => <option key={t.name} value={t.name}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Cardinalità">
          <select style={selectS} value={form.cardinality} onChange={e => set('cardinality', e.target.value)}>
            <option value="one">one</option>
            <option value="many">many</option>
          </select>
        </Field>
        <Field label="Direzione">
          <select style={selectS} value={form.direction} onChange={e => set('direction', e.target.value)}>
            <option value="outgoing">outgoing</option>
            <option value="incoming">incoming</option>
          </select>
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
  if (relations.length === 0) {
    return <p style={{ color: 'var(--color-slate-light)', fontSize: 14 }}>Nessuna relazione CI configurata.</p>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
          {['name', 'label', 'tipo Neo4j', 'target', 'card.', 'dir.', ''].map(h => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...relations].sort((a: CIRelationDef, b: CIRelationDef) => a.order - b.order).map(r => (
          <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
            <td style={{ padding: '8px', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 12 }}>{r.name}</td>
            <td style={{ padding: '8px' }}>{r.label}</td>
            <td style={{ padding: '8px', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 12 }}>{r.relationshipType}</td>
            <td style={{ padding: '8px', fontSize: 12 }}>{r.targetType}</td>
            <td style={{ padding: '8px', fontSize: 12 }}>{r.cardinality}</td>
            <td style={{ padding: '8px', fontSize: 12 }}>{r.direction}</td>
            <td style={{ padding: '8px' }}>
              <button style={{ ...btnDanger, padding: '3px 10px' }}
                aria-label={`Elimina relazione ${r.name}`}
                onClick={() => {
                  if (!confirm(`Eliminare la relazione "${r.name}"?`)) return
                  onRemove(r)
                }}>
                <X size={12} aria-hidden="true" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
