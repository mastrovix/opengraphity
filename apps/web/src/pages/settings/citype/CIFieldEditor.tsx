import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { Modal } from '@/components/Modal'
import { GET_ENUM_TYPES } from '@/graphql/queries'
import type { CIFieldDef } from '@/contexts/MetamodelContext'
import { Trans, useTranslation } from 'react-i18next'
import {
  inputS, selectS, textareaS, labelS,
  btnPrimary, btnSecondary,
  FIELD_TYPES, enumOptionLabel,
} from '../shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import type { EnumTypeRef } from '../shared/designerStyles'
import { palette } from '@/lib/tokens'

// Re-export shared button styles for any remaining consumers (E-09: one definition, in ui/styles).
export { btnPrimary, btnSecondary, btnDanger } from '@/components/ui/styles'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnumTypeOption extends EnumTypeRef { name: string }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelS}>{label}</label>
      {children}
    </div>
  )
}

// ── FieldForm ─────────────────────────────────────────────────────────────────

export interface FieldForm {
  name: string; label: string; fieldType: string
  required: boolean; defaultValue: string
  enumTypeId: string | null
  validationScript: string; visibilityScript: string; defaultScript: string
  order: number
}

export const emptyFieldForm = (): FieldForm => ({
  name: '', label: '', fieldType: 'string', required: false,
  defaultValue: '', enumTypeId: null, validationScript: '',
  visibilityScript: '', defaultScript: '', order: 0,
})

export function fieldToForm(f: CIFieldDef): FieldForm {
  return {
    name:             f.name,
    label:            f.label,
    fieldType:        f.fieldType,
    required:         f.required,
    defaultValue:     '',
    enumTypeId:       (f as unknown as { enumTypeId?: string | null }).enumTypeId ?? null,
    validationScript: f.validationScript ?? '',
    visibilityScript: f.visibilityScript ?? '',
    defaultScript:    f.defaultScript ?? '',
    order:            f.order,
  }
}

// ── CIFieldEditor (Modal — used for base type fields) ─────────────────────────

interface FieldModalProps {
  open:          boolean
  onClose:       () => void
  onSave:        (form: FieldForm) => Promise<void>
  initial:       FieldForm | null
  existingCount: number
}

export function CIFieldEditor({ open, onClose, onSave, initial, existingCount }: FieldModalProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<FieldForm>(initial ?? { ...emptyFieldForm(), order: existingCount })
  const [saving, setSaving] = useState(false)
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')

  const { data: enumData } = useQuery<{ enumTypes: EnumTypeOption[] }>(GET_ENUM_TYPES, {
    fetchPolicy: 'cache-and-network',
  })
  const enumTypes = enumData?.enumTypes ?? []

  const set = (k: keyof FieldForm, v: unknown) => setForm((p) => ({ ...p, [k]: v }))
  const selectedEnum = form.enumTypeId ? enumTypes.find((e) => e.id === form.enumTypeId) : null

  return (
    <Modal open={open} onClose={onClose} title={initial ? t('citypeDesigner.field.editTitle', { name: initial.name }) : t('citypeDesigner.addField')} width={560}
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
          <Input style={inputS} value={form.name} disabled={!!initial}
            onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label={`${t('common.label')} *`}>
          <Input style={inputS} value={form.label} onChange={(e) => set('label', e.target.value)} />
        </Field>
        <Field label={t('common.type')}>
          <Select style={selectS} value={form.fieldType} onChange={(e) => {
            set('fieldType', e.target.value)
            if (e.target.value !== 'enum') set('enumTypeId', null)
          }}>
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label={t('common.order')}>
          <Input style={inputS} type="number" value={form.order} onChange={(e) => set('order', Number(e.target.value))} />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <input type="checkbox" id="req" checked={form.required} onChange={(e) => set('required', e.target.checked)} style={{ cursor: 'pointer' }} />
        <label htmlFor="req" style={{ fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>{t('citypeDesigner.field.required')}</label>
      </div>

      {form.fieldType === 'enum' && (
        <Field label={t('citypeDesigner.field.enumRef')}>
          <Select style={selectS} value={form.enumTypeId ?? ''} onChange={(e) => set('enumTypeId', e.target.value || null)}>
            <option value="">{t('citypeDesigner.field.selectEnum')}</option>
            {enumTypes.map((e) => (
              <option key={e.id} value={e.id}>{enumOptionLabel(e, t)}</option>
            ))}
          </Select>
          {selectedEnum && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {selectedEnum.values.map((v) => (
                <Pill key={v} bg={palette.info.bg} color="var(--color-brand)" radius={12} style={{ fontWeight: 400 }}>
                  {v}
                </Pill>
              ))}
            </div>
          )}
        </Field>
      )}

      <Field label={t('citypeDesigner.field.defaultValue')}>
        <Input style={inputS} value={form.defaultValue} onChange={(e) => set('defaultValue', e.target.value)} />
      </Field>

      {/* Script tabs */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 16 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {(['validation', 'visibility', 'default'] as const).map((tab) => (
            <button type="button" key={tab} onClick={() => setScriptTab(tab)}
              style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                background: scriptTab === tab ? 'var(--color-brand-light)' : 'var(--color-slate-bg)',
                color: scriptTab === tab ? 'var(--color-brand)' : 'var(--color-slate)',
                fontWeight: scriptTab === tab ? 600 : 400 }}>
              {tab}Script
            </button>
          ))}
        </div>

        {scriptTab === 'validation' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
              <Trans i18nKey="citypeDesigner.field.validationHint" components={{ code: <code /> }} />
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.validationScript}
              onChange={(e) => set('validationScript', e.target.value)}
              placeholder={t('citypeDesigner.field.validationPlaceholder')} />
          </div>
        )}
        {scriptTab === 'visibility' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
              <Trans i18nKey="citypeDesigner.field.visibilityHint" components={{ code: <code /> }} />
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.visibilityScript}
              onChange={(e) => set('visibilityScript', e.target.value)}
              placeholder={t('citypeDesigner.field.visibilityPlaceholder')} />
          </div>
        )}
        {scriptTab === 'default' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
              <Trans i18nKey="citypeDesigner.field.defaultHint" components={{ code: <code /> }} />
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.defaultScript}
              onChange={(e) => set('defaultScript', e.target.value)}
              placeholder={t('citypeDesigner.field.defaultPlaceholder')} />
          </div>
        )}
      </div>
    </Modal>
  )
}

// Re-export for legacy consumers
export { Plus } from 'lucide-react'
