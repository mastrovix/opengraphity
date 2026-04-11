import { useState } from 'react'
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface FieldDef {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
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

interface Props {
  entityType:    string
  fields:        FieldDef[]
  workflowSteps: string[]   // e.g. ['new','assigned','in_progress','resolved','closed']
  flat?:         boolean    // when true, renders without the outer card wrapper (for use inside tabs)
}

// ── Empty forms ───────────────────────────────────────────────────────────────

interface VisibilityForm {
  triggerField: string
  triggerValue: string
  targetField:  string
  action:       'show' | 'hide'
}

function emptyVisForm(fields: FieldDef[]): VisibilityForm {
  return {
    triggerField: fields[0]?.name ?? '',
    triggerValue: '',
    targetField:  fields[1]?.name ?? fields[0]?.name ?? '',
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
    onError:     (e) => toast.error(e.message),
  })
  const [updateRule] = useMutation(UPDATE_FIELD_VISIBILITY_RULE, {
    onCompleted: () => { void refetch(); setEditingId(null); toast.success(t('fieldRules.visibility.updated')) },
    onError:     (e) => toast.error(e.message),
  })
  const [deleteRule] = useMutation(DELETE_FIELD_VISIBILITY_RULE, {
    onCompleted: () => { void refetch(); toast.success(t('fieldRules.visibility.deleted')) },
    onError:     (e) => toast.error(e.message),
  })

  const triggerField   = fields.find((f) => f.name === form.triggerField)
  const isEnumTrigger  = triggerField?.fieldType === 'enum'

  const editTrigger    = fields.find((f) => f.name === editForm.triggerField)
  const isEnumEdit     = editTrigger?.fieldType === 'enum'

  function handleCreate() {
    if (!form.triggerField || !form.targetField || !form.triggerValue) return
    void createRule({ variables: { entityType, ...form } })
  }

  function startEdit(rule: VisibilityRule) {
    setEditingId(rule.id)
    setEditForm({ triggerField: rule.triggerField, triggerValue: rule.triggerValue, targetField: rule.targetField, action: rule.action as 'show' | 'hide' })
  }

  function handleUpdate() {
    if (!editingId) return
    void updateRule({ variables: { id: editingId, ...editForm } })
  }

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {t('fieldRules.visibility.title')}
          </div>
          <div style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', marginTop: 2 }}>{t('fieldRules.visibility.subtitle')}</div>
        </div>
        <button style={btnPrimary} onClick={() => { setAdding(true); setForm(emptyVisForm(fields)) }} disabled={adding}>
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
        <div style={{ padding: '20px 16px', textAlign: 'center', color: '#94a3b8', fontSize: 'var(--font-size-body)', border: '1px dashed #e5e7eb', borderRadius: 8 }}>
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
          <div key={rule.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 6, background: '#f8fafc', border: '1px solid #e5e7eb', marginBottom: 6, fontSize: 'var(--font-size-body)' }}>
            <span style={{ color: 'var(--color-slate-dark)' }}>
              {t('fieldRules.visibility.ruleDesc', { triggerField: rule.triggerField, triggerValue: rule.triggerValue, action: rule.action === 'show' ? t('fieldRules.show') : t('fieldRules.hide'), targetField: rule.targetField })}
            </span>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button style={{ ...btnSecondary, padding: '4px 8px' }} onClick={() => startEdit(rule)}><Edit2 size={12} /></button>
              <button style={btnDanger} onClick={() => { void deleteRule({ variables: { id: rule.id } }) }}><Trash2 size={12} /></button>
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
  return (
    <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={labelS}>{t('fieldRules.visibility.triggerField')}</label>
          <select style={selectS} value={form.triggerField} onChange={(e) => onChange({ triggerField: e.target.value, triggerValue: '' })}>
            {fields.map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelS}>{t('fieldRules.visibility.triggerValue')}</label>
          {isEnumTrigger && triggerField?.enumValues.length ? (
            <select style={selectS} value={form.triggerValue} onChange={(e) => onChange({ triggerValue: e.target.value })}>
              <option value="">— scegli —</option>
              {triggerField.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          ) : (
            <input style={inputS} value={form.triggerValue} onChange={(e) => onChange({ triggerValue: e.target.value })} placeholder={t('fieldRules.visibility.triggerValuePlaceholder')} />
          )}
        </div>
        <div>
          <label style={labelS}>{t('fieldRules.visibility.action')}</label>
          <select style={selectS} value={form.action} onChange={(e) => onChange({ action: e.target.value as 'show' | 'hide' })}>
            <option value="show">{t('fieldRules.show')}</option>
            <option value="hide">{t('fieldRules.hide')}</option>
          </select>
        </div>
        <div>
          <label style={labelS}>{t('fieldRules.visibility.targetField')}</label>
          <select style={selectS} value={form.targetField} onChange={(e) => onChange({ targetField: e.target.value })}>
            {fields.filter((f) => f.name !== form.triggerField).map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button style={btnSecondary} onClick={onCancel}><X size={13} /> {t('common.cancel')}</button>
        <button style={btnPrimary}   onClick={onSave}><Check size={13} /> {t('common.save')}</button>
      </div>
    </div>
  )
}

// ── Requirement Rules Section ─────────────────────────────────────────────────

function RequirementRulesSection({ entityType, fields, workflowSteps }: { entityType: string; fields: FieldDef[]; workflowSteps: string[] }) {
  const { t } = useTranslation()

  const { data, refetch } = useQuery<{ fieldRequirementRules: RequirementRule[] }>(
    GET_FIELD_REQUIREMENT_RULES,
    { variables: { entityType }, fetchPolicy: 'cache-and-network' },
  )
  const rules = data?.fieldRequirementRules ?? []

  const [setReq]    = useMutation(SET_FIELD_REQUIREMENT,   { onCompleted: () => { void refetch() }, onError: (e) => toast.error(e.message) })
  const [deleteReq] = useMutation(DELETE_FIELD_REQUIREMENT, { onCompleted: () => { void refetch() }, onError: (e) => toast.error(e.message) })

  // Build a lookup: "fieldName|workflowStep" → rule
  const ruleMap = new Map<string, RequirementRule>()
  for (const r of rules) {
    ruleMap.set(`${r.fieldName}|${r.workflowStep ?? ''}`, r)
  }

  const stepOptions = ['', ...workflowSteps]

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
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {t('fieldRules.requirement.title')}
      </div>
      <div style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', marginBottom: 10 }}>{t('fieldRules.requirement.subtitle')}</div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 'var(--font-size-body)', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px', color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>
                {t('fieldRules.requirement.field')}
              </th>
              {stepOptions.map((s) => (
                <th key={s} style={{ textAlign: 'center', padding: '6px 8px', color: '#64748b', fontWeight: 600, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>
                  {s === '' ? t('fieldRules.requirement.allSteps') : s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.name} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '7px 8px', color: 'var(--color-slate-dark)', fontWeight: 500 }}>
                  {field.label || field.name}
                  <span style={{ marginLeft: 5, color: '#94a3b8', fontSize: 'var(--font-size-table)' }}>{field.name}</span>
                </td>
                {stepOptions.map((step) => {
                  const key      = `${field.name}|${step}`
                  const rule     = ruleMap.get(key)
                  const required = rule?.required ?? false
                  return (
                    <td key={step} style={{ textAlign: 'center', padding: '7px 8px' }}>
                      <label style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="checkbox"
                          checked={required}
                          onChange={() => toggle(field.name, step || null, required)}
                          style={{ accentColor: 'var(--color-brand)', width: 14, height: 14 }}
                        />
                      </label>
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
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 24px', marginTop: 16 }}>
      {content}
    </div>
  )
}
