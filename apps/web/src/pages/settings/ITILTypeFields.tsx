import { useId, useMemo, useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { GET_TICKET_WORKFLOW_STEPS } from '@/graphql/queries'
import { localizedLabel, type LocalizedLabel } from '@/lib/localizedLabel'
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
import { srOnlyStyle } from '@/lib/a11y'

// ── FieldEditor (inline) ──────────────────────────────────────────────────────

/** Una fase offerta dal disegnatore: `only` elenca i workflow che la hanno, quando non sono tutti. */
export interface StepChoice { name: string; label: string; only: string[] | null }

/** Le fasi dei workflow del tipo, una volta per nome, nell'ordine in cui compaiono. */
export function stepChoicesOf(groups: ReadonlyArray<{ workflow: string; steps: ReadonlyArray<{ name: string; label: string; labels?: LocalizedLabel[] }> }>): StepChoice[] {
  const byName = new Map<string, { label: string; workflows: string[] }>()
  for (const g of groups) {
    for (const st of g.steps) {
      const hit = byName.get(st.name)
      if (hit) hit.workflows.push(g.workflow)
      else byName.set(st.name, { label: localizedLabel({ label: st.label, labels: st.labels ?? [] }), workflows: [g.workflow] })
    }
  }
  return [...byName.entries()].map(([name, v]) => ({ name, label: v.label, only: v.workflows.length < groups.length ? v.workflows : null }))
}

/**
 * IN QUALI FASI SI VEDE E SI MODIFICA IL CAMPO (secondo giro UI del 15 set 2026,
 * decisione del proprietario): su c-test la change chiedeva «Outcome» già
 * all'apertura. L'API applica le stesse regole da ogni canale
 * (`apps/api/src/lib/customFieldSteps.ts`).
 */
function StepRulesEditor({ form, set, steps }: {
  form: FieldFormState
  set: (key: keyof FieldFormState, val: unknown) => void
  /** Le fasi di TUTTI i workflow attivi del tipo; `only` = i workflow che la hanno, se non tutti. */
  steps: readonly StepChoice[]
}) {
  const { t } = useTranslation()
  const uid = useId()
  if (steps.length === 0) {
    return <p style={{ margin: '0 0 12px', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>{t('itilDesigner.steps.noWorkflow')}</p>
  }
  const toggle = (key: 'visibilitySteps' | 'editabilitySteps', name: string) =>
    set(key, form[key].includes(name) ? form[key].filter((s) => s !== name) : steps.map((s) => s.name).filter((s) => s === name || form[key].includes(s)))
  const radio = (group: 'visibilityMode' | 'editabilityMode', value: string, label: string) => (
    <label key={value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
      <input type="radio" name={`${uid}-${group}`} value={value} checked={form[group] === value} onChange={() => set(group, value)} />
      {label}
    </label>
  )
  const stepChecks = (key: 'visibilitySteps' | 'editabilitySteps', legend: string) => (
    <fieldset style={{ border: 'none', margin: '6px 0 0 22px', padding: 0 }}>
      <legend style={srOnlyStyle}>{legend}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
        {steps.map((s) => (
          <label key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form[key].includes(s.name)} onChange={() => toggle(key, s.name)} />
            {s.label}{s.only && <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}> ({t('itilDesigner.steps.onlyIn', { workflows: s.only.join(', ') })})</span>}
          </label>
        ))}
      </div>
      {form[key].length === 0 && <p role="alert" style={{ margin: '4px 0 0', color: 'var(--color-danger)', fontSize: 'var(--font-size-table)' }}>{t('itilDesigner.steps.chooseAtLeastOne')}</p>}
    </fieldset>
  )
  const legendS: React.CSSProperties = { ...labelS, padding: 0, marginBottom: 6 }
  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend style={legendS}>{t('itilDesigner.steps.visibilityLegend')}</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
          {radio('visibilityMode', 'always', t('itilDesigner.steps.always'))}
          {radio('visibilityMode', 'steps', t('itilDesigner.steps.onlySteps'))}
          {radio('visibilityMode', 'from', t('itilDesigner.steps.fromStep'))}
        </div>
        {form.visibilityMode === 'steps' && stepChecks('visibilitySteps', t('itilDesigner.steps.onlySteps'))}
        {form.visibilityMode === 'from' && (
          <div style={{ margin: '6px 0 0 22px', maxWidth: 260 }}>
            <Select aria-label={t('itilDesigner.steps.fromStepLabel')} style={selectS} value={form.visibilityFrom} onChange={(e) => set('visibilityFrom', e.target.value)}>
              <option value="">—</option>
              {steps.map((s) => <option key={s.name} value={s.name}>{s.only ? `${s.label} (${t('itilDesigner.steps.onlyIn', { workflows: s.only.join(', ') })})` : s.label}</option>)}
            </Select>
          </div>
        )}
      </fieldset>
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend style={legendS}>{t('itilDesigner.steps.editabilityLegend')}</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
          {radio('editabilityMode', 'visible', t('itilDesigner.steps.whereVisible'))}
          {radio('editabilityMode', 'steps', t('itilDesigner.steps.onlySteps'))}
        </div>
        {form.editabilityMode === 'steps' && stepChecks('editabilitySteps', t('itilDesigner.steps.onlySteps'))}
      </fieldset>
      <p style={{ margin: 0, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>
        {t('itilDesigner.steps.creationHint')}
      </p>
    </div>
  )
}

function FieldEditor({
  field, isSystem, onSave, onCancel, enumTypesData, offerEndUser = false, workflowSteps = [],
}: {
  field:         FieldFormState
  isSystem:      boolean
  /** Le fasi dei workflow del tipo (per le regole di fase dei campi del cliente). */
  workflowSteps?: readonly StepChoice[]
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

      {!isSystem && <StepRulesEditor form={form} set={set} steps={workflowSteps} />}

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
  onSaveField:      (typeId: string, fieldId: string | null, form: FieldFormState, isSystem?: boolean) => void
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
  // Le fasi di tutti i workflow attivi del tipo (su c-test gli incident ne hanno due): prima solo quelle del generico.
  const { data: stepsData } = useQuery<{ ticketWorkflowSteps: Array<{ workflow: string; steps: Array<{ name: string; label: string; labels: LocalizedLabel[] }> }> }>(
    GET_TICKET_WORKFLOW_STEPS, { variables: { entityType: typeName ?? '' }, skip: !typeName, fetchPolicy: 'cache-and-network' },
  )
  const stepChoices = useMemo(() => stepChoicesOf(stepsData?.ticketWorkflowSteps ?? []), [stepsData])

  return (
    <div>
      {/* Inline add-field form */}
      {addingField && (
        <FieldEditor
          field={emptyForm(fields.length + 1)}
          isSystem={false}
          offerEndUser={offerEndUser}
          workflowSteps={stepChoices}
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
                onSave={(form) => onSaveField(typeId, f.id, form, true)}
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
              workflowSteps={stepChoices}
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
