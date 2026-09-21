import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Input, LabelledField, Select } from '@/components/ui/FormControls'
import { inputS, selectS, labelS, btnPrimary, btnSecondary, btnDanger } from '@/components/ui/styles'
import { useConfirm } from '@/hooks/useConfirm'
import { useMetamodel, type CITypeDef, type CIRelationDef } from '@/contexts/MetamodelContext'
import { srOnlyStyle } from '@/lib/a11y'
import { shippedLabel } from '@/lib/shippedLabel'
import { palette } from '@/lib/tokens'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <LabelledField label={label} labelStyle={labelS} style={{ marginBottom: 14 }}>{children}</LabelledField>
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
  // G-13: il modale è sempre montato; riaprendolo si ritrovava la relazione
  // appena aggiunta, e sembrava che fosse stata duplicata.
  useEffect(() => { if (open) setForm(emptyRelForm()) }, [open])
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
            <option value="one">{t('citypeDesigner.relation.cardinalityOne')}</option>
            <option value="many">{t('citypeDesigner.relation.cardinalityMany')}</option>
          </Select>
        </Field>
        <Field label={t('citypeDesigner.relation.direction')}>
          <Select style={selectS} value={form.direction} onChange={e => set('direction', e.target.value)}>
            <option value="outgoing">{t('citypeDesigner.relation.directionOutgoing')}</option>
            <option value="incoming">{t('citypeDesigner.relation.directionIncoming')}</option>
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
  const { getCIType } = useMetamodel()
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
          {[t('citypeDesigner.relation.colName'), t('common.label'), t('citypeDesigner.relation.neo4jTypeShort'), t('citypeDesigner.relation.colTarget'), t('citypeDesigner.relation.colCardinality'), t('citypeDesigner.relation.colDirection')].map(h => (
            <th key={h} scope="col" style={{ textAlign: 'left', padding: '6px 8px' }}>{h}</th>
          ))}
          <th scope="col" style={{ padding: '6px 8px' }}><span style={srOnlyStyle}>{t('citypeDesigner.relation.colActions')}</span></th>
        </tr>
      </thead>
      <tbody>
        {[...relations].sort((a: CIRelationDef, b: CIRelationDef) => a.order - b.order).map(r => (
          <tr key={r.id} style={{ borderBottom: `1px solid ${palette.neutral.borderLight}` }}>
            <td style={{ padding: '8px', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 'var(--font-size-body)' }}>{r.name}</td>
            <td style={{ padding: '8px' }}>{shippedLabel('relation', r.name, r.label)}</td>
            <td style={{ padding: '8px', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 'var(--font-size-body)' }}>{r.relationshipType}</td>
            <td style={{ padding: '8px', fontSize: 'var(--font-size-body)' }}>{r.targetType === 'any' ? t('common.any') : (getCIType(r.targetType)?.label ?? r.targetType)}</td>
            <td style={{ padding: '8px', fontSize: 'var(--font-size-body)' }}>{r.cardinality === 'one' ? t('citypeDesigner.relation.cardinalityOne') : r.cardinality === 'many' ? t('citypeDesigner.relation.cardinalityMany') : r.cardinality}</td>
            <td style={{ padding: '8px', fontSize: 'var(--font-size-body)' }}>{r.direction === 'outgoing' ? t('citypeDesigner.relation.directionOutgoing') : r.direction === 'incoming' ? t('citypeDesigner.relation.directionIncoming') : r.direction}</td>
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
