import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { Layers, Layout, Plus, Trash2, Check, X } from 'lucide-react'
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

// ── Style constants ────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: '#0f1629', outline: 'none',
  backgroundColor: '#fff', boxSizing: 'border-box',
}

const selectS: React.CSSProperties = {
  ...inputS,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}

const textareaS: React.CSSProperties = {
  ...inputS, fontFamily: 'monospace', fontSize: 12, resize: 'vertical', minHeight: 80,
}

const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: '#374151', marginBottom: 4,
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 16px', border: 'none', borderRadius: 6, background: '#4f46e5',
  color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer',
}

const btnSecondary: React.CSSProperties = {
  padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: '#374151', fontSize: 13, cursor: 'pointer',
}

const btnDanger: React.CSSProperties = {
  padding: '6px 12px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: '#dc2626', fontSize: 12, cursor: 'pointer',
}

// ── Available icons ────────────────────────────────────────────────────────────

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock']
const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum']

// ── FormField helper ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelS}>{label}</label>
      {children}
    </div>
  )
}

// ── FieldModal ────────────────────────────────────────────────────────────────

interface FieldForm {
  name: string; label: string; fieldType: string
  required: boolean; defaultValue: string; enumValues: string
  validationScript: string; visibilityScript: string; defaultScript: string
  order: number
}

const emptyFieldForm = (): FieldForm => ({
  name: '', label: '', fieldType: 'string', required: false,
  defaultValue: '', enumValues: '[]', validationScript: '',
  visibilityScript: '', defaultScript: '', order: 0,
})

function fieldToForm(f: CIFieldDef): FieldForm {
  return {
    name: f.name, label: f.label, fieldType: f.fieldType,
    required: f.required, defaultValue: '',
    enumValues: JSON.stringify(f.enumValues ?? []),
    validationScript: f.validationScript ?? '',
    visibilityScript: f.visibilityScript ?? '',
    defaultScript: f.defaultScript ?? '',
    order: f.order,
  }
}

function FieldModal({
  open, onClose, onSave, initial, existingCount,
}: {
  open: boolean
  onClose: () => void
  onSave: (form: FieldForm) => Promise<void>
  initial: FieldForm | null
  existingCount: number
}) {
  const [form, setForm] = useState<FieldForm>(initial ?? { ...emptyFieldForm(), order: existingCount })
  const [saving, setSaving] = useState(false)
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')

  const set = (k: keyof FieldForm, v: unknown) => setForm(p => ({ ...p, [k]: v }))

  // Reset when re-opened
  const handleOpen = () => { setForm(initial ?? { ...emptyFieldForm(), order: existingCount }) }

  return (
    <Modal open={open} onClose={onClose} title={initial ? `Modifica campo: ${initial.name}` : 'Aggiungi campo'} width={560}
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
      <div onClick={handleOpen} style={{ display: 'none' }} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        <Field label="name (slug) *">
          <input style={inputS} value={form.name} disabled={!!initial}
            onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label="label *">
          <input style={inputS} value={form.label} onChange={e => set('label', e.target.value)} />
        </Field>
        <Field label="Tipo">
          <select style={selectS} value={form.fieldType} onChange={e => set('fieldType', e.target.value)}>
            {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Order">
          <input style={inputS} type="number" value={form.order} onChange={e => set('order', Number(e.target.value))} />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <input type="checkbox" id="req" checked={form.required} onChange={e => set('required', e.target.checked)} style={{ cursor: 'pointer' }} />
        <label htmlFor="req" style={{ fontSize: 13, cursor: 'pointer' }}>Obbligatorio</label>
      </div>

      {form.fieldType === 'enum' && (
        <Field label="Valori enum (array JSON)">
          <textarea style={textareaS} value={form.enumValues} onChange={e => set('enumValues', e.target.value)} placeholder='["valore1","valore2"]' />
        </Field>
      )}

      <Field label="Valore di default">
        <input style={inputS} value={form.defaultValue} onChange={e => set('defaultValue', e.target.value)} />
      </Field>

      {/* Script tabs */}
      <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 8, paddingTop: 16 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {(['validation', 'visibility', 'default'] as const).map(tab => (
            <button key={tab} onClick={() => setScriptTab(tab)}
              style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 12, cursor: 'pointer',
                background: scriptTab === tab ? '#eef2ff' : '#f9fafb',
                color: scriptTab === tab ? '#4f46e5' : '#6b7280',
                fontWeight: scriptTab === tab ? 600 : 400 }}>
              {tab}Script
            </button>
          ))}
        </div>

        {scriptTab === 'validation' && (
          <div>
            <p style={{ fontSize: 11, color: '#8892a4', margin: '0 0 6px' }}>
              Variabili: <code>value</code>, <code>input</code>. Usa <code>throw 'messaggio'</code> per errore.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.validationScript}
              onChange={e => set('validationScript', e.target.value)}
              placeholder={"// Esempio:\nif (!value.startsWith('http')) throw 'URL non valido'"} />
          </div>
        )}
        {scriptTab === 'visibility' && (
          <div>
            <p style={{ fontSize: 11, color: '#8892a4', margin: '0 0 6px' }}>
              Variabili: <code>input</code>. Ritorna <code>true/false</code>.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.visibilityScript}
              onChange={e => set('visibilityScript', e.target.value)}
              placeholder={"// Mostra solo se altro campo è valorizzato:\nreturn !!input.instanceType"} />
          </div>
        )}
        {scriptTab === 'default' && (
          <div>
            <p style={{ fontSize: 11, color: '#8892a4', margin: '0 0 6px' }}>
              Variabili: <code>input</code>. Ritorna il valore di default.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.defaultScript}
              onChange={e => set('defaultScript', e.target.value)}
              placeholder={"// Esempio:\nreturn input.instanceType === 'PostgreSQL' ? 5432 : 3306"} />
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── RelationModal ─────────────────────────────────────────────────────────────

interface RelationForm {
  name: string; label: string; relationshipType: string
  targetType: string; cardinality: string; direction: string; order: number
}

const emptyRelForm = (): RelationForm => ({
  name: '', label: '', relationshipType: 'DEPENDS_ON',
  targetType: 'any', cardinality: 'many', direction: 'outgoing', order: 0,
})

function RelationModal({
  open, onClose, onSave, allTypes,
}: {
  open: boolean
  onClose: () => void
  onSave: (form: RelationForm) => Promise<void>
  allTypes: CITypeDef[]
}) {
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

// ── CreateTypeDialog ──────────────────────────────────────────────────────────

function CreateTypeDialog({
  open, onClose, onSave,
}: {
  open: boolean; onClose: () => void
  onSave: (form: { name: string; label: string; icon: string; color: string }) => Promise<void>
}) {
  const [form, setForm] = useState({ name: '', label: '', icon: 'box', color: '#4f46e5' })
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
          <span style={{ fontSize: 12, color: '#6b7280' }}>{form.color}</span>
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

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedBase, setSelectedBase] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('settings')

  // Field state
  const [showFieldModal, setShowFieldModal] = useState(false)
  const [editingField, setEditingField] = useState<CIFieldDef | null>(null)

  // Relation state
  const [showRelModal, setShowRelModal] = useState(false)

  // Settings form
  const [settingsForm, setSettingsForm] = useState<{ label: string; icon: string; color: string; validationScript: string } | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)

  const selected = ciTypes.find(t => t.id === selectedId) ?? null

  // Sync settings form when selected type changes
  const selectType = (t: CITypeDef) => {
    setSelectedBase(false)
    setSelectedId(t.id)
    setActiveTab('settings')
    setSettingsForm({
      label: t.label,
      icon: t.icon ?? 'box',
      color: t.color ?? '#4f46e5',
      validationScript: t.validationScript ?? '',
    })
  }

  // Mutations
  const [createType] = useMutation(CREATE_CI_TYPE, { onCompleted: () => { refetch(); toast.success('Tipo creato') } })
  const [updateType] = useMutation(UPDATE_CI_TYPE, { onCompleted: () => { refetch(); toast.success('Salvato') } })
  const [deleteType] = useMutation(DELETE_CI_TYPE, {
    onCompleted: () => { refetch(); setSelectedId(null); toast.success('Tipo eliminato') },
  })
  const [addField] = useMutation(ADD_CI_FIELD, { onCompleted: () => { refetch(); setShowFieldModal(false); toast.success('Campo aggiunto') } })
  const [addBaseField] = useMutation(ADD_CI_FIELD, { onCompleted: () => { refetchBase(); setShowFieldModal(false); toast.success('Campo base aggiunto') } })
  const [removeField] = useMutation(REMOVE_CI_FIELD, { onCompleted: () => { refetch(); toast.success('Campo rimosso') } })
  const [addRelation] = useMutation(ADD_CI_RELATION, { onCompleted: () => { refetch(); setShowRelModal(false); toast.success('Relazione aggiunta') } })
  const [removeRelation] = useMutation(REMOVE_CI_RELATION, { onCompleted: () => { refetch(); toast.success('Relazione rimossa') } })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <Layers size={22} color="#4f46e5" />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>CI Type Designer</h1>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>

        {/* ── Left: type list ─────────────────────────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #e5e7eb' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0f1629' }}>Tipi CI</span>
            <button onClick={() => setShowCreate(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', border: 'none', borderRadius: 5, background: '#4f46e5', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
              <Plus size={12} /> Nuovo
            </button>
          </div>

          {loading && <div style={{ padding: 20, color: '#8892a4', fontSize: 13 }}>Caricamento…</div>}

          <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
            {/* ── Campi Base special entry ── */}
            <div onClick={() => { setSelectedBase(true); setSelectedId(null) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 16px', cursor: 'pointer',
                borderBottom: '1px solid #e5e7eb',
                background: selectedBase ? '#eef2ff' : '#f9fafb',
                borderLeft: selectedBase ? '3px solid #4f46e5' : '3px solid transparent',
              }}>
              <Layout size={16} color="#4f46e5" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: selectedBase ? 600 : 400, color: selectedBase ? '#4f46e5' : '#374151' }}>
                  Campi Base
                </div>
                <div style={{ fontSize: 11, color: '#8892a4' }}>Condivisi da tutti i tipi</div>
              </div>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 100, fontWeight: 600,
                background: '#e0e7ff', color: '#4f46e5' }}>
                Sistema
              </span>
            </div>
            {/* ── Separator ── */}
            <div style={{ padding: '6px 16px 4px', fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
              Tipi CI
            </div>

            {ciTypes.map(t => {
              const isSelected = t.id === selectedId
              return (
                <div key={t.id} onClick={() => selectType(t)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 16px', cursor: 'pointer',
                    borderBottom: '1px solid #f3f4f6',
                    background: isSelected ? '#eef2ff' : 'transparent',
                    borderLeft: isSelected ? '3px solid #4f46e5' : '3px solid transparent',
                  }}>
                  <CIIcon icon={t.icon} size={16} color={t.color ?? '#4f46e5'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: isSelected ? 600 : 400, color: isSelected ? '#4f46e5' : '#0f1629', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.label}
                    </div>
                    <div style={{ fontSize: 11, color: '#8892a4' }}>{t.name}</div>
                  </div>
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 100, fontWeight: 500,
                    background: t.active ? '#dcfce7' : '#f3f4f6',
                    color: t.active ? '#16a34a' : '#9ca3af' }}>
                    {t.active ? 'active' : 'inactive'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Right: type editor ──────────────────────────────────────── */}
        <div>
          {selectedBase && baseType ? (
            /* ── Campi Base panel ────────────────────────────────────── */
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                <Layout size={22} color="#4f46e5" />
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0f1629' }}>Campi Base</div>
                  <div style={{ fontSize: 11, color: '#8892a4' }}>Ereditati da tutti i tipi CI</div>
                </div>
              </div>
              {/* Description */}
              <div style={{ padding: '12px 24px', borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
                <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
                  Questi campi sono presenti in tutti i tipi CI e non possono essere eliminati.
                </p>
              </div>
              {/* Fields */}
              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Campi ({baseType.fields.length})
                  </span>
                  <button style={btnPrimary} onClick={() => { setEditingField(null); setShowFieldModal(true) }}>
                    <Plus size={12} style={{ marginRight: 4 }} />Aggiungi campo base
                  </button>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                      {['#', 'name', 'label', 'tipo', 'req', ''].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: '#8892a4', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...baseType.fields].sort((a, b) => a.order - b.order).map(f => (
                      <tr key={f.id} style={{ borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
                        <td style={{ padding: '8px', color: '#8892a4', fontSize: 12 }}>{f.order}</td>
                        <td style={{ padding: '8px' }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.name}</span>
                          <span style={{ marginLeft: 6, padding: '1px 5px', fontSize: 10, borderRadius: 3, background: '#e0e7ff', color: '#4f46e5', fontWeight: 600 }}>Sistema</span>
                        </td>
                        <td style={{ padding: '8px' }}>{f.label}</td>
                        <td style={{ padding: '8px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 4, background: '#f3f4f6', fontSize: 12, fontFamily: 'monospace' }}>{f.fieldType}</span>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>
                          {f.required ? <Check size={14} color="#16a34a" /> : <span style={{ color: '#d1d5db' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px' }}>
                          <button style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}
                            onClick={() => { setEditingField(f); setShowFieldModal(true) }}>
                            Modifica
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : !selected ? (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 40 }}>
              <EmptyState icon={<Layers size={32} color="#8892a4" />} title="Seleziona un tipo per modificarlo" />
            </div>
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CIIcon icon={selected.icon} size={22} color={selected.color ?? '#4f46e5'} />
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#0f1629' }}>{selected.label}</div>
                    <div style={{ fontSize: 11, color: '#8892a4' }}>{selected.name}</div>
                  </div>
                  {/* Active toggle */}
                  <button
                    onClick={() => updateType({ variables: { id: selected.id, input: { active: !selected.active } } })}
                    style={{ marginLeft: 8, padding: '3px 10px', border: '1px solid #e5e7eb', borderRadius: 100, fontSize: 11, cursor: 'pointer', background: selected.active ? '#dcfce7' : '#f3f4f6', color: selected.active ? '#16a34a' : '#9ca3af', fontWeight: 500 }}>
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
                    style={{ padding: '10px 14px', border: 'none', borderBottom: activeTab === tab ? '2px solid #4f46e5' : '2px solid transparent', marginBottom: -1, background: 'none', fontSize: 13, cursor: 'pointer', color: activeTab === tab ? '#4f46e5' : '#6b7280', fontWeight: activeTab === tab ? 600 : 400 }}>
                    {tab === 'settings' ? 'Impostazioni' : tab === 'fields' ? 'Campi' : tab === 'relations' ? 'Relazioni CI' : 'Preview'}
                  </button>
                ))}
              </div>

              <div style={{ padding: '20px 24px' }}>

                {/* ── Tab: Impostazioni ─────────────────────────────── */}
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
                        <span style={{ fontSize: 12, color: '#6b7280' }}>{settingsForm.color}</span>
                      </div>
                    </Field>
                    <Field label="Validation script (opzionale)">
                      <p style={{ fontSize: 11, color: '#8892a4', margin: '0 0 6px' }}>
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
                              label: settingsForm.label,
                              icon: settingsForm.icon,
                              color: settingsForm.color,
                              validationScript: settingsForm.validationScript || null,
                            } } })
                          } finally { setSettingsSaving(false) }
                        }}>
                        {settingsSaving ? 'Salvataggio…' : 'Salva impostazioni'}
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Tab: Campi ───────────────────────────────────── */}
                {activeTab === 'fields' && (() => {
                  const sortedFields = [...selected.fields].sort((a, b) => a.order - b.order)
                  const systemFields  = sortedFields.filter(f => f.isSystem)
                  const specificFields = sortedFields.filter(f => !f.isSystem)

                  const FieldTable = ({ fields, showActions }: { fields: CIFieldDef[]; showActions: boolean }) => (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                          {['#', 'name', 'label', 'tipo', 'req', ''].map(h => (
                            <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: '#8892a4', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map(f => (
                          <tr key={f.id} style={{ borderBottom: '1px solid #f3f4f6', background: f.isSystem ? '#f9fafb' : 'transparent' }}>
                            <td style={{ padding: '8px', color: '#8892a4', fontSize: 12 }}>{f.order}</td>
                            <td style={{ padding: '8px' }}>
                              <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.name}</span>
                              {f.isSystem && (
                                <span style={{ marginLeft: 6, padding: '1px 5px', fontSize: 10, borderRadius: 3, background: '#e0e7ff', color: '#4f46e5', fontWeight: 600 }}>Sistema</span>
                              )}
                            </td>
                            <td style={{ padding: '8px' }}>{f.label}</td>
                            <td style={{ padding: '8px' }}>
                              <span style={{ padding: '2px 8px', borderRadius: 4, background: '#f3f4f6', fontSize: 12, fontFamily: 'monospace' }}>{f.fieldType}</span>
                            </td>
                            <td style={{ padding: '8px', textAlign: 'center' }}>
                              {f.required ? <Check size={14} color="#16a34a" /> : <span style={{ color: '#d1d5db' }}>—</span>}
                            </td>
                            <td style={{ padding: '8px' }}>
                              {showActions && (
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}
                                    onClick={() => { setEditingField(f); setShowFieldModal(true) }}>
                                    Modifica
                                  </button>
                                  <button style={{ ...btnDanger, padding: '3px 10px' }}
                                    onClick={() => {
                                      if (!confirm(`Eliminare il campo "${f.name}"?`)) return
                                      removeField({ variables: { typeId: selected.id, fieldId: f.id } })
                                    }}>
                                    <X size={12} />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )

                  return (
                    <div>
                      {/* Campi base */}
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            Campi base ({systemFields.length})
                          </span>
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>Ereditati da __base__ — non modificabili</span>
                        </div>
                        {systemFields.length === 0 ? (
                          <p style={{ color: '#8892a4', fontSize: 13 }}>Nessun campo base.</p>
                        ) : (
                          <FieldTable fields={systemFields} showActions={false} />
                        )}
                      </div>

                      {/* Campi specifici */}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            Campi specifici ({specificFields.length})
                          </span>
                          <button style={btnPrimary} onClick={() => { setEditingField(null); setShowFieldModal(true) }}>
                            <Plus size={12} style={{ marginRight: 4 }} />Aggiungi campo
                          </button>
                        </div>
                        {specificFields.length === 0 ? (
                          <p style={{ color: '#8892a4', fontSize: 13 }}>Nessun campo specifico. Clicca "Aggiungi campo" per crearne uno.</p>
                        ) : (
                          <FieldTable fields={specificFields} showActions={true} />
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* ── Tab: Relazioni ────────────────────────────────── */}
                {activeTab === 'relations' && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                      <button style={btnPrimary} onClick={() => setShowRelModal(true)}>
                        <Plus size={12} style={{ marginRight: 4 }} />Aggiungi relazione
                      </button>
                    </div>

                    {selected.relations.length === 0 ? (
                      <p style={{ color: '#8892a4', fontSize: 13 }}>Nessuna relazione CI configurata.</p>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                            {['name', 'label', 'tipo Neo4j', 'target', 'card.', 'dir.', ''].map(h => (
                              <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: '#8892a4', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[...selected.relations].sort((a: CIRelationDef, b: CIRelationDef) => a.order - b.order).map(r => (
                            <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: 12 }}>{r.name}</td>
                              <td style={{ padding: '8px' }}>{r.label}</td>
                              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: 12 }}>{r.relationshipType}</td>
                              <td style={{ padding: '8px', fontSize: 12 }}>{r.targetType}</td>
                              <td style={{ padding: '8px', fontSize: 12 }}>{r.cardinality}</td>
                              <td style={{ padding: '8px', fontSize: 12 }}>{r.direction}</td>
                              <td style={{ padding: '8px' }}>
                                <button style={{ ...btnDanger, padding: '3px 10px' }}
                                  onClick={() => {
                                    if (!confirm(`Eliminare la relazione "${r.name}"?`)) return
                                    removeRelation({ variables: { typeId: selected.id, relationId: r.id } })
                                  }}>
                                  <X size={12} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {/* ── Tab: Preview ─────────────────────────────────── */}
                {activeTab === 'preview' && (
                  <div style={{ maxWidth: 520 }}>
                    <p style={{ fontSize: 13, color: '#8892a4', marginBottom: 16 }}>
                      Anteprima del form di creazione CI — campi specifici del tipo.
                    </p>
                    {selected.fields.length === 0 ? (
                      <p style={{ fontSize: 13, color: '#8892a4' }}>Nessun campo specifico da mostrare. Aggiungi campi nella tab "Campi".</p>
                    ) : (
                      <CIDynamicForm
                        ciType={selected}
                        onSubmit={async () => { toast.info('Preview — nessun dato salvato') }}
                        onCancel={() => setActiveTab('fields')}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <CreateTypeDialog open={showCreate} onClose={() => setShowCreate(false)}
        onSave={async (form) => {
          await createType({ variables: { input: form } })
        }} />

      <FieldModal
        open={showFieldModal}
        onClose={() => setShowFieldModal(false)}
        initial={editingField ? fieldToForm(editingField) : null}
        existingCount={selectedBase ? (baseType?.fields.length ?? 0) : (selected?.fields.length ?? 0)}
        onSave={async (form) => {
          const targetId = selectedBase ? baseType?.id : selected?.id
          if (!targetId) return
          let enumValues: string[] = []
          if (form.fieldType === 'enum') {
            try { enumValues = JSON.parse(form.enumValues) } catch { enumValues = [] }
          }
          const input = {
            name:             form.name,
            label:            form.label,
            fieldType:        form.fieldType,
            required:         form.required,
            defaultValue:     form.defaultValue || null,
            enumValues,
            order:            form.order,
            validationScript: form.validationScript || null,
            visibilityScript: form.visibilityScript || null,
            defaultScript:    form.defaultScript    || null,
          }
          if (selectedBase) {
            await addBaseField({ variables: { typeId: targetId, input } })
          } else {
            await addField({ variables: { typeId: targetId, input } })
          }
        }}
      />

      <RelationModal
        open={showRelModal}
        onClose={() => setShowRelModal(false)}
        allTypes={ciTypes}
        onSave={async (form) => {
          if (!selected) return
          await addRelation({
            variables: {
              typeId: selected.id,
              input: {
                name:             form.name,
                label:            form.label,
                relationshipType: form.relationshipType,
                targetType:       form.targetType,
                cardinality:      form.cardinality,
                direction:        form.direction,
                order:            form.order,
              },
            },
          })
        }}
      />
    </div>
  )
}
