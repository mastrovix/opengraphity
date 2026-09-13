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
  const { t } = useTranslation()
  const [form, setForm] = useState<RelationForm>(emptyRelForm())
  const [saving, setSaving] = useState(false)
  const set = (k: keyof RelationForm, v: unknown) => setForm(p => ({ ...p, [k]: v }))

  return (
    <Modal open={open} onClose={onClose} title={t('citypeDesigner.relation.addTitle')} width={500}
      footer={
        <>
          <button type="button" style={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}
            onClick={async () => {
              setSaving(true)
              try { await onSave(form) } finally { setSaving(false) }
            }}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </>
      }>
      <div className="og-pair">
        <Field label={t('citypeDesigner.field.slugName')}>
          <Input style={inputS} value={form.name}
            onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label={`${t('common.label')} *`}>
          <Input style={inputS} value={form.label} onChange={e => set('label', e.target.value)} />
        </Field>
        <Field label={t('citypeDesigner.relation.neo4jType')}>
          <Input style={inputS} value={form.relationshipType}
            onChange={e => set('relationshipType', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="DEPENDS_ON" />
        </Field>
        <Field label={t('citypeDesigner.relation.targetType')}>
          <Select style={selectS} value={form.targetType} onChange={e => set('targetType', e.target.value)}>
            <option value="any">{t('common.any')}</option>
            {allTypes.map(t => <option key={t.name} value={t.name}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label={t('citypeDesigner.relation.cardinality')}>
          <Select style={selectS} value={form.cardinality} onChange={e => set('cardinality', e.target.value)}>
            <option value="one">one</option>
            <option value="many">many</option>
          </Select>
        </Field>
        <Field label={t('citypeDesigner.relation.direction')}>
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
  /**
   * Tipo spedito col prodotto (A-6): `removeCIRelation` ha
   * `WHERE t.scope = 'tenant'`, quindi qui non cancellava niente e
   * l'interfaccia diceva «Relazione rimossa». Il bottone non c'è.
   */
  readOnly?: boolean
}

export function CIRelationTable({ relations, onRemove, readOnly = false }: RelationTableProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const handleRemove = async (r: CIRelationDef) => {
    if (await confirm({ title: t('ciTypeDesigner.deleteRelationTitle', { name: r.name }), danger: true })) onRemove(r)
  }
  if (relations.length === 0) {
    return <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('citypeDesigner.relation.empty')}</p>
  }
  return (
    <div className="og-scroll-x">
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
      <thead>
        <tr>
          {['name', 'label', t('citypeDesigner.relation.neo4jTypeShort'), 'target', 'card.', 'dir.', ''].map(h => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px' }}>{h}</th>
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
              {readOnly
                ? <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('ciTypeDesigner.shippedRelationLabel')}</span>
                : (
                  <button type="button" style={{ ...btnDanger, padding: '3px 10px' }}
                    aria-label={t('citypeDesigner.relation.deleteAria', { name: r.name })}
                    onClick={() => void handleRemove(r)}>
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
  )
}
