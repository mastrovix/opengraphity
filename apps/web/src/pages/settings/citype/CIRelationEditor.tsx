import { Button } from '@/components/Button'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Input, LabelledField, Select } from '@/components/ui/FormControls'
import { labelS } from '@/components/ui/styles'
import { useConfirm } from '@/hooks/useConfirm'
import { SimpleTable, type SimpleColumn } from '@/components/ui/SimpleTable'
import { useMetamodel, type CITypeDef, type CIRelationDef } from '@/contexts/MetamodelContext'
import { shippedLabel } from '@/lib/shippedLabel'

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
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              try { await onSave(form) } finally { setSaving(false) }
            }}
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }>
      <div className="og-pair">
        <Field label={t('citypeDesigner.field.slugName')}>
          <Input value={form.name}
            onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label={`${t('common.label')} *`}>
          <Input value={form.label} onChange={e => set('label', e.target.value)} />
        </Field>
        <Field label={t('citypeDesigner.relation.neo4jType')}>
          <Input value={form.relationshipType}
            onChange={e => set('relationshipType', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="DEPENDS_ON" />
        </Field>
        <Field label={t('citypeDesigner.relation.targetType')}>
          <Select value={form.targetType} onChange={e => set('targetType', e.target.value)}>
            <option value="any">{t('common.any')}</option>
            {allTypes.map(t => <option key={t.name} value={t.name}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label={t('citypeDesigner.relation.cardinality')}>
          <Select value={form.cardinality} onChange={e => set('cardinality', e.target.value)}>
            <option value="one">{t('citypeDesigner.relation.cardinalityOne')}</option>
            <option value="many">{t('citypeDesigner.relation.cardinalityMany')}</option>
          </Select>
        </Field>
        <Field label={t('citypeDesigner.relation.direction')}>
          <Select value={form.direction} onChange={e => set('direction', e.target.value)}>
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
  // The app's small table (26 Sep 2026: it was hand-made).
  const columns: SimpleColumn<CIRelationDef>[] = [
    { key: 'name', label: t('citypeDesigner.relation.colName') },
    { key: 'label', label: t('common.label'), render: (_v, r) => shippedLabel('relation', r.name, r.label) },
    { key: 'relationshipType', label: t('citypeDesigner.relation.neo4jTypeShort') },
    { key: 'targetType', label: t('citypeDesigner.relation.colTarget'), render: (_v, r) => (r.targetType === 'any' ? t('common.any') : (getCIType(r.targetType)?.label ?? r.targetType)) },
    { key: 'cardinality', label: t('citypeDesigner.relation.colCardinality'), render: (_v, r) => (r.cardinality === 'one' ? t('citypeDesigner.relation.cardinalityOne') : r.cardinality === 'many' ? t('citypeDesigner.relation.cardinalityMany') : r.cardinality) },
    { key: 'direction', label: t('citypeDesigner.relation.colDirection'), render: (_v, r) => (r.direction === 'outgoing' ? t('citypeDesigner.relation.directionOutgoing') : r.direction === 'incoming' ? t('citypeDesigner.relation.directionIncoming') : r.direction) },
    { key: 'id', label: t('citypeDesigner.relation.colActions'), sortable: false, render: (_v, r) => (readOnly
      ? <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('ciTypeDesigner.shippedRelationLabel')}</span>
      : (
        <Button variant="danger" size="xs"
          aria-label={t('citypeDesigner.relation.deleteAria', { name: r.name })}
          onClick={() => handleRemove(r)}
        >
          <X size={12} aria-hidden="true" />
        </Button>
      )) },
  ]
  return <SimpleTable<CIRelationDef> columns={columns} rows={[...relations].sort((a, b) => a.order - b.order)} />
}
