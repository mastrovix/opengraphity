import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Plus, X, Check } from 'lucide-react'
import { DesignerFieldRow } from './shared/DesignerFieldRow'
import {
  inputS, selectS, textareaS, labelS, btnPrimary, btnSecondary, FIELD_TYPES,
} from './shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import type { EnumTypeRef } from './shared/designerStyles'
import { enumOptionLabel } from './shared/designerStyles'
import type { ITILField, FieldFormState, EnumTypeOption } from './useITILTypeDesigner'
import { emptyForm, fieldToForm } from './useITILTypeDesigner'
import { colors } from '@/lib/tokens'
import { useWorkflowSteps } from '@/hooks/useWorkflowSteps'

// ── FieldEditor (inline) ──────────────────────────────────────────────────────

function FieldEditor({
  field, isSystem, onSave, onCancel, enumTypesData, offerEndUser = false,
}: {
  field:         FieldFormState
  isSystem:      boolean
  /** Il tipo si apre dal portale (incident, service_request): il campo si può offrire all'utente finale. */
  offerEndUser?: boolean
  onSave:        (f: FieldFormState) => void
  onCancel:      () => void
  enumTypesData: { enumTypes: EnumTypeRef[] } | undefined
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<FieldFormState>(field)
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')
  const set = (key: keyof FieldFormState, val: unknown) =>
    setForm((f) => ({ ...f, [key]: val }))

  return (
    <div style={{ background: 'var(--color-slate-bg)', border: `1px solid ${colors.border}`, borderRadius: 8, padding: 16, marginBottom: 8 }}>
      {/* name + label */}
      <div className="og-pair" style={{ marginBottom: 12 }}>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldName')}</label>
          <input
            style={{ ...inputS, background: isSystem || !!field.name ? colors.slateBg : colors.white }}
            value={form.name}
            disabled={isSystem || !!field.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="field_name"
          />
        </div>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldLabel')}</label>
          <input
            style={inputS}
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder={t('citypeDesigner.field.labelPlaceholder')}
          />
        </div>
      </div>

      {/* type + order + required */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldType')}</label>
          <Select
            style={{ ...selectS, background: isSystem ? colors.slateBg : colors.white }}
            value={form.fieldType}
            // Il tipo di un campo esistente non cambia: i valori sono già sui ticket (ondata 4).
            disabled={isSystem || !!field.name}
            onChange={(e) => { set('fieldType', e.target.value); if (e.target.value !== 'enum') set('enumTypeId', null) }}
          >
            {FIELD_TYPES.map((ft) => (
              <option key={ft} value={ft}>{ft}</option>
            ))}
          </Select>
        </div>
        <div>
          <label style={labelS}>{t('itilDesigner.order')}</label>
          <Input style={inputS} type="number" value={form.order} onChange={(e) => set('order', Number(e.target.value))} />
        </div>
        <div style={{ paddingTop: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: isSystem ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={form.required}
              disabled={isSystem}
              onChange={(e) => set('required', e.target.checked)}
            />
            {t('itilDesigner.required')}
          </label>
        </div>
      </div>

      {/* Ondata 4: il portale offre all'utente finale solo i campi marcati. */}
      {offerEndUser && !isSystem && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.visibleToEndUser} onChange={(e) => set('visibleToEndUser', e.target.checked)} />
            {t('itilDesigner.visibleToEndUser')}
          </label>
          <p style={{ margin: '4px 0 0 22px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>{t('itilDesigner.visibleToEndUserHint')}</p>
        </div>
      )}

      {/* enum dropdown */}
      {form.fieldType === 'enum' && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelS}>{t('itilDesigner.enumRef')} *</label>
          <Select
            style={selectS}
            value={form.enumTypeId ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, enumTypeId: e.target.value || null }))}
          >
            <option value="">{t('itilDesigner.selectEnum')}</option>
            {(enumTypesData?.enumTypes ?? []).map((e) => (
              <option key={e.id} value={e.id}>{enumOptionLabel(e, t)}</option>
            ))}
          </Select>
        </div>
      )}

      {/* scripts (collapsible) */}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}>
          {t('itilDesigner.advancedScripts')}
        </summary>
        <div style={{ paddingTop: 8 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {(['validation', 'visibility', 'default'] as const).map((tab) => (
              <button type="button" key={tab} onClick={() => setScriptTab(tab)}
                style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                  background: scriptTab === tab ? 'var(--color-brand-light)' : colors.slateBg,
                  color:      scriptTab === tab ? 'var(--color-brand)' : 'var(--color-slate)',
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
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.validationScript}
                onChange={(e) => set('validationScript', e.target.value)}
                placeholder={t('itilDesigner.fieldValidationPlaceholder')} />
            </div>
          )}
          {scriptTab === 'visibility' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                <Trans i18nKey="citypeDesigner.field.visibilityHint" components={{ code: <code /> }} />
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.visibilityScript}
                onChange={(e) => set('visibilityScript', e.target.value)}
                placeholder={t('itilDesigner.visibilityPlaceholder')} />
            </div>
          )}
          {scriptTab === 'default' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                <Trans i18nKey="citypeDesigner.field.defaultHint" components={{ code: <code /> }} />
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.defaultScript}
                onChange={(e) => set('defaultScript', e.target.value)}
                placeholder={t('itilDesigner.defaultPlaceholder')} />
            </div>
          )}
        </div>
      </details>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" style={btnSecondary} onClick={onCancel}>
          <X size={13} /> {t('common.cancel')}
        </button>
        <button type="button" style={btnPrimary} onClick={() => onSave(form)}>
          <Check size={13} /> {t('itilDesigner.save')}
        </button>
      </div>
    </div>
  )
}

// ── ITILTypeFields component ──────────────────────────────────────────────────

export interface ITILTypeFieldsProps {
  typeId:           string
  fields:           ITILField[]
  editingFieldId:   string | null
  setEditingFieldId: (id: string | null) => void
  addingField:      boolean
  setAddingField:   (v: boolean) => void
  onSaveField:      (typeId: string, fieldId: string | null, form: FieldFormState) => void
  onDeleteField:    (typeId: string, fieldId: string) => void
  enumTypesData:    { enumTypes: EnumTypeOption[] } | undefined
  /** Il nome del tipo ITIL: incident e service_request si aprono anche dal portale. */
  typeName?:        string
}

export function ITILTypeFields({
  typeId, fields, editingFieldId, setEditingFieldId,
  addingField, setAddingField, onSaveField, onDeleteField,
  enumTypesData, typeName,
}: ITILTypeFieldsProps) {
  const offerEndUser = typeName === 'incident' || typeName === 'service_request'
  const { t } = useTranslation()
  const systemFields = fields.filter((f) => f.isSystem).sort((a, b) => a.order - b.order)
  // U-13: lo stato di un ticket è il passo del suo workflow, non il vocabolario agganciato al campo.
  const workflow = useWorkflowSteps(typeName ?? '')
  const statusNote = workflow.steps.length > 0
    ? t('itilDesigner.statusFromWorkflow', { steps: workflow.steps.map((st) => workflow.labelFor(st.name)).join(', ') })
    : undefined
  const customFields = fields.filter((f) => !f.isSystem).sort((a, b) => a.order - b.order)

  return (
    <div>
      {/* Inline add-field form */}
      {addingField && (
        <FieldEditor
          field={emptyForm(fields.length + 1)}
          isSystem={false}
          offerEndUser={offerEndUser}
          onSave={(form) => onSaveField(typeId, null, form)}
          onCancel={() => setAddingField(false)}
          enumTypesData={enumTypesData}
        />
      )}

      {/* System fields */}
      {systemFields.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em', marginBottom: 8 }}>
            {t('itilDesigner.systemFields', { count: systemFields.length })}
          </div>
          {systemFields.map((f) => (
            editingFieldId === f.id ? (
              <FieldEditor
                key={f.id}
                field={fieldToForm(f)}
                isSystem={true}
                onSave={(form) => onSaveField(typeId, f.id, form)}
                onCancel={() => setEditingFieldId(null)}
                enumTypesData={enumTypesData}
              />
            ) : (
              <DesignerFieldRow
                key={f.id}
                field={f}
                onEdit={() => setEditingFieldId(f.id)}
                onDelete={() => onDeleteField(typeId, f.id)}
                editLabel={t('common.edit')}
                systemFieldLabel={t('itilDesigner.systemField')}
                valuesNote={f.name === 'status' ? statusNote : undefined}
              />
            )
          ))}
        </div>
      )}

      {/* Custom fields */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em' }}>
            {t('itilDesigner.customFields', { count: customFields.length })}
          </div>
          <button type="button"
            style={btnPrimary}
            onClick={() => { setAddingField(true); setEditingFieldId(null) }}
            disabled={addingField}
          >
            <Plus size={13} /> {t('itilDesigner.addField')}
          </button>
        </div>
        {customFields.map((f) => (
          editingFieldId === f.id ? (
            <FieldEditor
              key={f.id}
              field={fieldToForm(f)}
              isSystem={false}
              offerEndUser={offerEndUser}
              onSave={(form) => onSaveField(typeId, f.id, form)}
              onCancel={() => setEditingFieldId(null)}
              enumTypesData={enumTypesData}
            />
          ) : (
            <DesignerFieldRow
              key={f.id}
              field={f}
              onEdit={() => setEditingFieldId(f.id)}
              onDelete={() => onDeleteField(typeId, f.id)}
              editLabel={t('common.edit')}
              systemFieldLabel={t('itilDesigner.systemField')}
            />
          )
        ))}
        {customFields.length === 0 && !addingField && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', border: '1px dashed var(--border)', borderRadius: 8 }}>
            {t('itilDesigner.noCustomFields')}
          </div>
        )}
      </div>
    </div>
  )
}
