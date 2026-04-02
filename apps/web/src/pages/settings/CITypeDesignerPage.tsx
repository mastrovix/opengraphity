import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { Layers, Layout, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { GET_CI_TYPES, GET_BASE_CI_TYPE } from '@/graphql/queries'
import {
  CREATE_CI_TYPE, UPDATE_CI_TYPE, DELETE_CI_TYPE,
  ADD_CI_FIELD, REMOVE_CI_FIELD,
  ADD_CI_RELATION, REMOVE_CI_RELATION,
} from '@/graphql/mutations'
import { Modal } from '@/components/Modal'
import { EmptyState } from '@/components/EmptyState'
import { CIIcon } from '@/lib/ciIcon'
import { CIDynamicForm } from '@/components/CIDynamicForm'
import type { CITypeDef, CIFieldDef, CIRelationDef } from '@/contexts/MetamodelContext'
import { CITypeList } from './citype/CITypeList'
import { CIFieldEditor, CIFieldTable, fieldToForm, btnPrimary, btnSecondary, btnDanger } from './citype/CIFieldEditor'
import type { FieldForm } from './citype/CIFieldEditor'
import { CIRelationEditor, CIRelationTable } from './citype/CIRelationEditor'
import type { RelationForm } from './citype/CIRelationEditor'

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

const textareaS: React.CSSProperties = {
  ...inputS, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 12, resize: 'vertical', minHeight: 80,
}

const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock']

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelS}>{label}</label>
      {children}
    </div>
  )
}

// ── CreateTypeDialog ──────────────────────────────────────────────────────────

function CreateTypeDialog({
  open, onClose, onSave,
}: {
  open: boolean; onClose: () => void
  onSave: (form: { name: string; label: string; icon: string; color: string }) => Promise<void>
}) {
  const [form, setForm] = useState({ name: '', label: '', icon: 'box', color: 'var(--color-brand)' })
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))

  return (
    <Modal open={open} onClose={onClose} title="Nuovo tipo CI" width={440}
      footer={
        <>
          <button style={btnSecondary} onClick={onClose}>Annulla</button>
          <button style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}
            onClick={async () => {
              if (!form.name || !form.label) { toast.error('Nome e label obbligatori'); return }
              setSaving(true)
              try { await onSave(form); onClose() } finally { setSaving(false) }
            }}>
            {saving ? 'Creazione…' : 'Crea tipo'}
          </button>
        </>
      }>
      <Field label="name (slug, snake_case) *">
        <input style={inputS} value={form.name} placeholder="es. load_balancer"
          onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
      </Field>
      <Field label="label (nome visualizzato) *">
        <input style={inputS} value={form.label} placeholder="es. Load Balancer"
          onChange={e => set('label', e.target.value)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
        <Field label="Icona">
          <select style={selectS} value={form.icon} onChange={e => set('icon', e.target.value)}>
            {ICONS.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 20 }}>
          <CIIcon icon={form.icon} size={24} color={form.color} />
        </div>
      </div>
      <Field label="Colore">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="color" value={form.color} onChange={e => set('color', e.target.value)}
            style={{ width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }} />
          <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>{form.color}</span>
        </div>
      </Field>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'settings' | 'fields' | 'relations' | 'preview'

export function CITypeDesignerPage() {
  const { data, loading, refetch } = useQuery<{ ciTypes: CITypeDef[] }>(GET_CI_TYPES)
  const { data: baseData, refetch: refetchBase } = useQuery<{ baseCIType: CITypeDef }>(GET_BASE_CI_TYPE)
  const ciTypes: CITypeDef[] = data?.ciTypes ?? []
  const baseType: CITypeDef | null = baseData?.baseCIType ?? null

  const [selectedId, setSelectedId]   = useState<string | null>(null)
  const [selectedBase, setSelectedBase] = useState(false)
  const [showCreate, setShowCreate]   = useState(false)
  const [activeTab, setActiveTab]     = useState<Tab>('settings')

  const [showFieldModal, setShowFieldModal] = useState(false)
  const [editingField, setEditingField]     = useState<CIFieldDef | null>(null)
  const [showRelModal, setShowRelModal]     = useState(false)

  const [settingsForm, setSettingsForm] = useState<{ label: string; icon: string; color: string; validationScript: string } | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)

  const selected = ciTypes.find(t => t.id === selectedId) ?? null

  const selectType = (t: CITypeDef) => {
    setSelectedBase(false)
    setSelectedId(t.id)
    setActiveTab('settings')
    setSettingsForm({ label: t.label, icon: t.icon ?? 'box', color: t.color ?? 'var(--color-brand)', validationScript: t.validationScript ?? '' })
  }

  const [createType] = useMutation(CREATE_CI_TYPE, { onCompleted: () => { refetch(); toast.success('Tipo creato') } })
  const [updateType] = useMutation(UPDATE_CI_TYPE, { onCompleted: () => { refetch(); toast.success('Salvato') } })
  const [deleteType] = useMutation(DELETE_CI_TYPE, { onCompleted: () => { refetch(); setSelectedId(null); toast.success('Tipo eliminato') } })
  const [addField]     = useMutation(ADD_CI_FIELD,    { onCompleted: () => { refetch();     setShowFieldModal(false); toast.success('Campo aggiunto') } })
  const [addBaseField] = useMutation(ADD_CI_FIELD,    { onCompleted: () => { refetchBase(); setShowFieldModal(false); toast.success('Campo base aggiunto') } })
  const [removeField]  = useMutation(REMOVE_CI_FIELD, { onCompleted: () => { refetch(); toast.success('Campo rimosso') } })
  const [addRelation]  = useMutation(ADD_CI_RELATION, { onCompleted: () => { refetch(); setShowRelModal(false); toast.success('Relazione aggiunta') } })
  const [removeRelation] = useMutation(REMOVE_CI_RELATION, { onCompleted: () => { refetch(); toast.success('Relazione rimossa') } })

  async function handleSaveField(form: FieldForm) {
    const targetId = selectedBase ? baseType?.id : selected?.id
    if (!targetId) return
    let enumValues: string[] = []
    if (form.fieldType === 'enum') {
      try { enumValues = JSON.parse(form.enumValues) } catch { enumValues = [] }
    }
    const input = {
      name: form.name, label: form.label, fieldType: form.fieldType,
      required: form.required, defaultValue: form.defaultValue || null,
      enumValues, order: form.order,
      validationScript: form.validationScript || null,
      visibilityScript: form.visibilityScript || null,
      defaultScript:    form.defaultScript    || null,
    }
    if (selectedBase) {
      await addBaseField({ variables: { typeId: targetId, input } })
    } else {
      await addField({ variables: { typeId: targetId, input } })
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <Layers size={22} color="var(--color-brand)" />
        <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>CI Type Designer</h1>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>

        {/* Left: type list */}
        <CITypeList
          ciTypes={ciTypes}
          selectedId={selectedId}
          selectedBase={selectedBase}
          loading={loading}
          onSelectType={selectType}
          onSelectBase={() => { setSelectedBase(true); setSelectedId(null) }}
          onNew={() => setShowCreate(true)}
        />

        {/* Right: type editor */}
        <div>
          {selectedBase && baseType ? (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                <Layout size={22} color="var(--color-brand)" />
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Campi Base</div>
                  <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Ereditati da tutti i tipi CI</div>
                </div>
              </div>
              <div style={{ padding: '12px 24px', borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
                <p style={{ fontSize: 14, color: 'var(--color-slate)', margin: 0 }}>
                  Questi campi sono presenti in tutti i tipi CI e non possono essere eliminati.
                </p>
              </div>
              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Campi ({baseType.fields.length})
                  </span>
                  <button style={btnPrimary} onClick={() => { setEditingField(null); setShowFieldModal(true) }}>
                    <Plus size={12} style={{ marginRight: 4 }} />Aggiungi campo base
                  </button>
                </div>
                <CIFieldTable
                  fields={[...baseType.fields].sort((a, b) => a.order - b.order)}
                  showActions={false}
                  onEdit={(f) => { setEditingField(f); setShowFieldModal(true) }}
                />
              </div>
            </div>
          ) : !selected ? (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 40 }}>
              <EmptyState icon={<Layers size={32} color="var(--color-slate-light)" />} title="Seleziona un tipo per modificarlo" />
            </div>
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CIIcon icon={selected.icon} size={22} color={selected.color ?? 'var(--color-brand)'} />
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{selected.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>{selected.name}</div>
                  </div>
                  <button
                    onClick={() => updateType({ variables: { id: selected.id, input: { active: !selected.active } } })}
                    style={{ marginLeft: 8, padding: '3px 10px', border: '1px solid #e5e7eb', borderRadius: 100, fontSize: 12, cursor: 'pointer', background: selected.active ? '#dcfce7' : '#f3f4f6', color: selected.active ? '#16a34a' : 'var(--color-slate-light)', fontWeight: 500 }}>
                    {selected.active ? '● active' : '○ inactive'}
                  </button>
                </div>
                <button style={btnDanger}
                  onClick={() => {
                    if (!confirm(`Eliminare il tipo "${selected.label}"? Questa azione è irreversibile.`)) return
                    deleteType({ variables: { id: selected.id } })
                  }}>
                  <Trash2 size={12} style={{ marginRight: 4 }} />Elimina tipo
                </button>
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 20px' }}>
                {(['settings', 'fields', 'relations', 'preview'] as Tab[]).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    style={{ padding: '10px 14px', border: 'none', borderBottom: activeTab === tab ? '2px solid #0284c7' : '2px solid transparent', marginBottom: -1, background: 'none', fontSize: 14, cursor: 'pointer', color: activeTab === tab ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: activeTab === tab ? 600 : 400 }}>
                    {tab === 'settings' ? 'Impostazioni' : tab === 'fields' ? 'Campi' : tab === 'relations' ? 'Relazioni CI' : 'Preview'}
                  </button>
                ))}
              </div>

              <div style={{ padding: '20px 24px' }}>

                {/* Tab: Impostazioni */}
                {activeTab === 'settings' && settingsForm && (
                  <div style={{ maxWidth: 480 }}>
                    <Field label="Label">
                      <input style={inputS} value={settingsForm.label}
                        onChange={e => setSettingsForm(p => p && ({ ...p, label: e.target.value }))} />
                    </Field>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
                      <Field label="Icona">
                        <select style={selectS} value={settingsForm.icon}
                          onChange={e => setSettingsForm(p => p && ({ ...p, icon: e.target.value }))}>
                          {ICONS.map(i => <option key={i} value={i}>{i}</option>)}
                        </select>
                      </Field>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20 }}>
                        <CIIcon icon={settingsForm.icon} size={24} color={settingsForm.color} />
                      </div>
                    </div>
                    <Field label="Colore">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="color" value={settingsForm.color}
                          onChange={e => setSettingsForm(p => p && ({ ...p, color: e.target.value }))}
                          style={{ width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }} />
                        <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>{settingsForm.color}</span>
                      </div>
                    </Field>
                    <Field label="Validation script (opzionale)">
                      <p style={{ fontSize: 12, color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                        Variabili: <code>input</code>. Usa <code>throw 'msg'</code> per errore globale.
                      </p>
                      <textarea style={{ ...textareaS, minHeight: 100 }} value={settingsForm.validationScript}
                        onChange={e => setSettingsForm(p => p && ({ ...p, validationScript: e.target.value }))}
                        placeholder={"// Esempio: validazione cross-field\nif (input.env === 'production' && !input.owner) throw 'Ambiente production richiede un owner'"} />
                    </Field>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button style={{ ...btnPrimary, opacity: settingsSaving ? 0.6 : 1 }} disabled={settingsSaving}
                        onClick={async () => {
                          setSettingsSaving(true)
                          try {
                            await updateType({ variables: { id: selected.id, input: {
                              label: settingsForm.label, icon: settingsForm.icon,
                              color: settingsForm.color, validationScript: settingsForm.validationScript || null,
                            } } })
                          } finally { setSettingsSaving(false) }
                        }}>
                        {settingsSaving ? 'Salvataggio…' : 'Salva impostazioni'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Tab: Campi */}
                {activeTab === 'fields' && (() => {
                  const sortedFields   = [...selected.fields].sort((a, b) => a.order - b.order)
                  const systemFields   = sortedFields.filter(f => f.isSystem)
                  const specificFields = sortedFields.filter(f => !f.isSystem)
                  return (
                    <div>
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Campi base ({systemFields.length})</span>
                          <span style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Ereditati da __base__ — non modificabili</span>
                        </div>
                        {systemFields.length === 0
                          ? <p style={{ color: 'var(--color-slate-light)', fontSize: 14 }}>Nessun campo base.</p>
                          : <CIFieldTable fields={systemFields} showActions={false} />
                        }
                      </div>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Campi specifici ({specificFields.length})</span>
                          <button style={btnPrimary} onClick={() => { setEditingField(null); setShowFieldModal(true) }}>
                            <Plus size={12} style={{ marginRight: 4 }} />Aggiungi campo
                          </button>
                        </div>
                        {specificFields.length === 0
                          ? <p style={{ color: 'var(--color-slate-light)', fontSize: 14 }}>Nessun campo specifico. Clicca "Aggiungi campo" per crearne uno.</p>
                          : <CIFieldTable
                              fields={specificFields}
                              showActions={true}
                              onEdit={(f) => { setEditingField(f); setShowFieldModal(true) }}
                              onRemove={(f) => removeField({ variables: { typeId: selected.id, fieldId: f.id } })}
                            />
                        }
                      </div>
                    </div>
                  )
                })()}

                {/* Tab: Relazioni */}
                {activeTab === 'relations' && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                      <button style={btnPrimary} onClick={() => setShowRelModal(true)}>
                        <Plus size={12} style={{ marginRight: 4 }} />Aggiungi relazione
                      </button>
                    </div>
                    <CIRelationTable
                      relations={selected.relations}
                      onRemove={(r: CIRelationDef) => removeRelation({ variables: { typeId: selected.id, relationId: r.id } })}
                    />
                  </div>
                )}

                {/* Tab: Preview */}
                {activeTab === 'preview' && (
                  <div style={{ maxWidth: 520 }}>
                    <p style={{ fontSize: 14, color: 'var(--color-slate-light)', marginBottom: 16 }}>
                      Anteprima del form di creazione CI — campi specifici del tipo.
                    </p>
                    {selected.fields.length === 0
                      ? <p style={{ fontSize: 14, color: 'var(--color-slate-light)' }}>Nessun campo specifico da mostrare. Aggiungi campi nella tab "Campi".</p>
                      : <CIDynamicForm ciType={selected} onSubmit={async () => { toast.info('Preview — nessun dato salvato') }} onCancel={() => setActiveTab('fields')} />
                    }
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <CreateTypeDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSave={async (form) => { await createType({ variables: { input: form } }) }}
      />

      <CIFieldEditor
        open={showFieldModal}
        onClose={() => setShowFieldModal(false)}
        initial={editingField ? fieldToForm(editingField) : null}
        existingCount={selectedBase ? (baseType?.fields.length ?? 0) : (selected?.fields.length ?? 0)}
        onSave={handleSaveField}
      />

      <CIRelationEditor
        open={showRelModal}
        onClose={() => setShowRelModal(false)}
        allTypes={ciTypes}
        onSave={async (form: RelationForm) => {
          if (!selected) return
          await addRelation({
            variables: {
              typeId: selected.id,
              input: { name: form.name, label: form.label, relationshipType: form.relationshipType, targetType: form.targetType, cardinality: form.cardinality, direction: form.direction, order: form.order },
            },
          })
        }}
      />
    </div>
  )
}
