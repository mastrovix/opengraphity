import { useId, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Edit2, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  GET_FIELD_VISIBILITY_RULES,
  GET_FIELD_REQUIREMENT_RULES,
} from '@/graphql/queries'
import {
  CREATE_FIELD_VISIBILITY_RULE,
  UPDATE_FIELD_VISIBILITY_RULE,
  DELETE_FIELD_VISIBILITY_RULE,
  SET_FIELD_REQUIREMENT,
  DELETE_FIELD_REQUIREMENT,
} from '@/graphql/mutations'
import { inputS, selectS, labelS, btnPrimary, btnSecondary, btnDanger } from './designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import { colors, palette } from '@/lib/tokens'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { showError } from '@/lib/showError'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FieldDef {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
  /** Il vocabolario del campo enum: i valori si leggono con le sue etichette (secondo giro UI · V-18). */
  enumTypeName?: string | null
}

interface VisibilityRule {
  id:           string
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       string
}

interface RequirementRule {
  id:           string
  fieldName:    string
  required:     boolean
  workflowStep: string | null
}

/**
 * Una fase offerta dalle regole: nome tecnico ed ETICHETTA tradotta
 * (revisione totale · G-10). Prima le colonne portavano il nome tecnico
 * (`in_progress`) e l'elenco veniva dai soli workflow SENZA categoria: un
 * passo che esiste solo in un workflow di categoria — su c-test gli incident
 * ne hanno due — non era selezionabile, quindi la regola «root_cause
 * obbligatorio entrando in containment» non si poteva creare.
 */
export interface StepOption { name: string; label: string }

interface Props {
  entityType:    string
  fields:        FieldDef[]
  workflowSteps: StepOption[]
  flat?:         boolean    // when true, renders without the outer card wrapper (for use inside tabs)
}

// ── Empty forms ───────────────────────────────────────────────────────────────

interface VisibilityForm {
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       'show' | 'hide'
}

/**
 * The fields a rule on `trigger` can show or hide: every field but the trigger
 * itself. A rule never targets the field that triggers it: with a single
 * field there is no target at all (tour of 23 Sep 2026: the default target
 * was the trigger itself, and such a rule was saved).
 */
function targetsOf(fields: FieldDef[], trigger: string): FieldDef[] {
  return fields.filter((f) => f.name !== trigger)
}

/**
 * The target a form stands for, shown and saved alike: its own while the list
 * offers it, else the first field the list offers — the one it shows. Choosing
 * as trigger the field that was the target left the target on the trigger:
 * the list showed «Category», the rule saved was serial → serial (tour of
 * 23 Sep 2026). Empty when there is nothing to target.
 */
function targetOf(fields: FieldDef[], form: VisibilityForm): string {
  const targets = targetsOf(fields, form.triggerField)
  return targets.some((f) => f.name === form.targetField) ? form.targetField : (targets[0]?.name ?? '')
}

function emptyVisForm(fields: FieldDef[]): VisibilityForm {
  const triggerField = fields[0]?.name ?? ''
  return {
    triggerField,
    triggerValue: '',
    targetField:  targetsOf(fields, triggerField)[0]?.name ?? '',
    action:       'show',
  }
}

// ── Visibility Rules Section ──────────────────────────────────────────────────

function VisibilityRulesSection({ entityType, fields }: { entityType: string; fields: FieldDef[] }) {
  const { t } = useTranslation()
  const [adding,    setAdding]    = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form,      setForm]      = useState<VisibilityForm>(() => emptyVisForm(fields))
  const [editForm,  setEditForm]  = useState<VisibilityForm>(() => emptyVisForm(fields))

  const { data, refetch } = useQuery<{ fieldVisibilityRules: VisibilityRule[] }>(
    GET_FIELD_VISIBILITY_RULES,
    { variables: { entityType }, fetchPolicy: 'cache-and-network' },
  )
  const rules = data?.fieldVisibilityRules ?? []

  const [createRule] = useMutation(CREATE_FIELD_VISIBILITY_RULE, {
    onCompleted: () => { void refetch(); setAdding(false); setForm(emptyVisForm(fields)); toast.success(t('fieldRules.visibility.created')) },
    onError:     (e) => showError(e),
  })
  const [updateRule] = useMutation(UPDATE_FIELD_VISIBILITY_RULE, {
    onCompleted: () => { void refetch(); setEditingId(null); toast.success(t('fieldRules.visibility.updated')) },
    onError:     (e) => showError(e),
  })
  const [deleteRule] = useMutation(DELETE_FIELD_VISIBILITY_RULE, {
    onCompleted: () => { void refetch(); toast.success(t('fieldRules.visibility.deleted')) },
    onError:     (e) => showError(e),
  })

  const triggerField   = fields.find((f) => f.name === form.triggerField)
  const isEnumTrigger  = triggerField?.fieldType === 'enum'

  const editTrigger    = fields.find((f) => f.name === editForm.triggerField)
  const isEnumEdit     = editTrigger?.fieldType === 'enum'

  function handleCreate() {
    const targetField = targetOf(fields, form)
    if (!form.triggerField || !targetField || !form.triggerValue) return
    void createRule({ variables: { entityType, ...form, targetField } })
  }

  function startEdit(rule: VisibilityRule) {
    setEditingId(rule.id)
    setEditForm({ triggerField: rule.triggerField, triggerValue: rule.triggerValue, targetField: rule.targetField, action: rule.action as 'show' | 'hide' })
  }

  function handleUpdate() {
    if (!editingId) return
    void updateRule({ variables: { id: editingId, ...editForm, targetField: targetOf(fields, editForm) } })
  }

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {t('fieldRules.visibility.title')}
          </div>
          <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 2 }}>{t('fieldRules.visibility.subtitle')}</div>
        </div>
        <button type="button" style={btnPrimary} onClick={() => { setAdding(true); setForm(emptyVisForm(fields)) }} disabled={adding}>
          <Plus size={13} /> {t('fieldRules.visibility.add')}
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <VisibilityRuleForm
          form={form}
          fields={fields}
          isEnumTrigger={isEnumTrigger}
          triggerField={triggerField}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          onSave={handleCreate}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* List */}
      {rules.length === 0 && !adding && (
        <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          {t('fieldRules.visibility.empty')}
        </div>
      )}
      {rules.map((rule) => (
        editingId === rule.id ? (
          <VisibilityRuleForm
            key={rule.id}
            form={editForm}
            fields={fields}
            isEnumTrigger={isEnumEdit}
            triggerField={editTrigger}
            onChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))}
            onSave={handleUpdate}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={rule.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: 'var(--color-slate-bg)', border: '1px solid var(--border)', marginBottom: 6, fontSize: 'var(--font-size-body)' }}>
            <span style={{ color: 'var(--color-slate-dark)' }}>
              {t('fieldRules.visibility.ruleDesc', { triggerField: rule.triggerField, triggerValue: rule.triggerValue, action: rule.action === 'show' ? t('fieldRules.show') : t('fieldRules.hide'), targetField: rule.targetField })}
            </span>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {/* G-15: le due icone non avevano nome accessibile: da screen
                  reader erano «pulsante», «pulsante». */}
              <button type="button" style={{ ...btnSecondary, padding: '4px 8px' }}
                aria-label={t('fieldRules.visibility.editRule', { field: rule.targetField })}
                onClick={() => startEdit(rule)}><Edit2 size={12} aria-hidden="true" /></button>
              <button type="button" style={btnDanger}
                aria-label={t('fieldRules.visibility.deleteRule', { field: rule.targetField })}
                onClick={() => { void deleteRule({ variables: { id: rule.id } }) }}><Trash2 size={12} aria-hidden="true" /></button>
            </div>
          </div>
        )
      ))}
    </div>
  )
}

function VisibilityRuleForm({ form, fields, isEnumTrigger, triggerField, onChange, onSave, onCancel }: {
  form:          VisibilityForm
  fields:        FieldDef[]
  isEnumTrigger: boolean | undefined
  triggerField:  FieldDef | undefined
  onChange:      (patch: Partial<VisibilityForm>) => void
  onSave:        () => void
  onCancel:      () => void
}) {
  const { t } = useTranslation()
  const { labelOf } = useDomainVocabularies()
  // G-15: le etichette del form non erano collegate ai controlli (screen
  // reader: «menu» senza nome). `useId` dà la radice degli identificativi.
  const ids = useId()
  const targets = targetsOf(fields, form.triggerField)
  // Nothing to target: the form says so and saves nothing.
  const noTarget = targets.length === 0
  return (
    <div style={{ background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 8, padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label htmlFor={`${ids}-trigger-field`} style={labelS}>{t('fieldRules.visibility.triggerField')}</label>
          <Select id={`${ids}-trigger-field`} style={selectS} value={form.triggerField} onChange={(e) => onChange({ triggerField: e.target.value, triggerValue: '' })}>
            {fields.map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor={`${ids}-trigger-value`} style={labelS}>{t('fieldRules.visibility.triggerValue')}</label>
          {isEnumTrigger && triggerField?.enumValues.length ? (
            <Select id={`${ids}-trigger-value`} style={selectS} value={form.triggerValue} onChange={(e) => onChange({ triggerValue: e.target.value })}>
              <option value="">{t('pages.taskView.choose')}</option>
              {triggerField.enumValues.map((v) => <option key={v} value={v}>{(triggerField.enumTypeName && labelOf(triggerField.enumTypeName, v)) || v}</option>)}
            </Select>
          ) : (
            <Input id={`${ids}-trigger-value`} style={inputS} value={form.triggerValue} onChange={(e) => onChange({ triggerValue: e.target.value })} placeholder={t('fieldRules.visibility.triggerValuePlaceholder')} />
          )}
        </div>
        <div>
          <label htmlFor={`${ids}-action`} style={labelS}>{t('fieldRules.visibility.action')}</label>
          <Select id={`${ids}-action`} style={selectS} value={form.action} onChange={(e) => onChange({ action: e.target.value as 'show' | 'hide' })}>
            <option value="show">{t('fieldRules.show')}</option>
            <option value="hide">{t('fieldRules.hide')}</option>
          </Select>
        </div>
        <div>
          <label htmlFor={`${ids}-target-field`} style={labelS}>{t('fieldRules.visibility.targetField')}</label>
          <Select id={`${ids}-target-field`} style={selectS} value={targetOf(fields, form)} onChange={(e) => onChange({ targetField: e.target.value })}
            aria-describedby={noTarget ? `${ids}-no-target` : undefined}>
            {targets.map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
          </Select>
        </div>
      </div>
      {noTarget && (
        <p id={`${ids}-no-target`} style={{ margin: '0 0 10px', fontSize: 'var(--font-size-body)', color: palette.warning.text }}>
          {t('fieldRules.visibility.noTarget')}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" style={btnSecondary} onClick={onCancel}><X size={13} /> {t('common.cancel')}</button>
        <button type="button" style={{ ...btnPrimary, opacity: noTarget ? 0.6 : 1 }} disabled={noTarget}
          aria-describedby={noTarget ? `${ids}-no-target` : undefined} onClick={onSave}><Check size={13} /> {t('common.save')}</button>
      </div>
    </div>
  )
}

// ── Requirement Rules Section ─────────────────────────────────────────────────

function RequirementRulesSection({ entityType, fields, workflowSteps }: { entityType: string; fields: FieldDef[]; workflowSteps: StepOption[] }) {
  const { t } = useTranslation()

  const { data, refetch } = useQuery<{ fieldRequirementRules: RequirementRule[] }>(
    GET_FIELD_REQUIREMENT_RULES,
    { variables: { entityType }, fetchPolicy: 'cache-and-network' },
  )
  const rules = data?.fieldRequirementRules ?? []

  const [setReq]    = useMutation(SET_FIELD_REQUIREMENT,   { onCompleted: () => { void refetch() }, onError: (e) => showError(e) })
  const [deleteReq] = useMutation(DELETE_FIELD_REQUIREMENT, { onCompleted: () => { void refetch() }, onError: (e) => showError(e) })

  // Build a lookup: "fieldName|workflowStep" → rule
  const ruleMap = new Map<string, RequirementRule>()
  for (const r of rules) {
    ruleMap.set(`${r.fieldName}|${r.workflowStep ?? ''}`, r)
  }

  // La prima colonna è «tutte le fasi»; poi una per fase, con l'etichetta.
  const stepOptions: StepOption[] = [{ name: '', label: '' }, ...workflowSteps]

  function toggle(fieldName: string, workflowStep: string | null, currentRequired: boolean) {
    if (currentRequired) {
      const existing = ruleMap.get(`${fieldName}|${workflowStep ?? ''}`)
      if (existing) void deleteReq({ variables: { id: existing.id } })
    } else {
      void setReq({ variables: { entityType, fieldName, required: true, workflowStep: workflowStep || null } })
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {t('fieldRules.requirement.title')}
      </div>
      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 10 }}>{t('fieldRules.requirement.subtitle')}</div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 'var(--font-size-body)', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px', whiteSpace: 'nowrap' }}>
                {t('fieldRules.requirement.field')}
              </th>
              {stepOptions.map((s) => (
                <th key={s.name} style={{ textAlign: 'center', padding: '6px 8px', whiteSpace: 'nowrap' }}>
                  {s.name === '' ? t('fieldRules.requirement.allSteps') : s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.name} style={{ borderBottom: `1px solid ${palette.neutral.borderLight}` }}>
                <td style={{ padding: '7px 8px', color: 'var(--color-slate-dark)', fontWeight: 500 }}>
                  {field.label || field.name}
                  <span style={{ marginLeft: 5, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-table)' }}>{field.name}</span>
                </td>
                {stepOptions.map((step) => {
                  const key      = `${field.name}|${step.name}`
                  const rule     = ruleMap.get(key)
                  const required = rule?.required ?? false
                  return (
                    <td key={step.name} style={{ textAlign: 'center', padding: '7px 8px' }}>
                      <input
                        type="checkbox"
                        checked={required}
                        aria-label={`${field.label || field.name} — ${step.name === '' ? t('fieldRules.requirement.allSteps') : step.label}`}
                        onChange={() => toggle(field.name, step.name || null, required)}
                        style={{ accentColor: 'var(--color-brand)', width: 14, height: 14, cursor: 'pointer' }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main Export ───────────────────────────────────────────────────────────────

export function FieldRulesPanel({ entityType, fields, workflowSteps, flat = false }: Props) {
  const content = (
    <>
      <VisibilityRulesSection entityType={entityType} fields={fields} />
      <RequirementRulesSection entityType={entityType} fields={fields} workflowSteps={workflowSteps} />
    </>
  )
  if (flat) return content
  return (
    <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, padding: '20px 24px', marginTop: 16 }}>
      {content}
    </div>
  )
}
