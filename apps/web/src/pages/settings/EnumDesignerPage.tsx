import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Lock, Plus, X, Save, Trash2, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { GET_ENUM_TYPES } from '@/graphql/queries'
import {
  CREATE_ENUM_TYPE,
  UPDATE_ENUM_TYPE,
  DELETE_ENUM_TYPE,
} from '@/graphql/mutations'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnumType {
  id:        string
  name:      string
  label:     string
  values:    string[]
  isSystem:  boolean
  scope:     string
  createdAt: string
  updatedAt: string
}

// ── Styles ────────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}
const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer',
}
const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 13, cursor: 'pointer',
}
const btnDanger: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '6px 12px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: '#ef4444', fontSize: 13, cursor: 'pointer',
}

const SCOPE_LABELS: Record<string, string> = {
  shared: 'Condivisi',
  itil:   'ITIL',
  cmdb:   'CMDB',
}

// ── CreateEnumDialog ──────────────────────────────────────────────────────────

function CreateEnumDialog({
  onClose,
  onCreated,
}: { onClose: () => void; onCreated: (e: EnumType) => void }) {
  const [name, setName]   = useState('')
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<'shared' | 'itil' | 'cmdb'>('shared')

  const [createEnum, { loading }] = useMutation(CREATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: (d: unknown) => {
      const result = (d as { createEnumType: EnumType }).createEnumType
      toast.success(`Enum "${result.label}" creato`)
      onCreated(result)
    },
    onError: (e) => toast.error(e.message),
  })

  const handleSubmit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!name.match(/^[a-z][a-z0-9_]*$/)) {
      toast.error('Il nome deve essere in snake_case (es. "my_enum")')
      return
    }
    void createEnum({ variables: { input: { name, label, values: [], scope } } })
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-enum-title"
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 10, padding: 24, width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-enum-title" style={{ fontSize: 16, fontWeight: 600, marginBottom: 20 }}>
          Nuovo Enum Type
        </h2>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label htmlFor="enum-name" style={labelS}>Nome (snake_case)</label>
            <input
              id="enum-name"
              style={inputS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="es. priority"
              required
              pattern="[a-z][a-z0-9_]*"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="enum-label" style={labelS}>Label</label>
            <input
              id="enum-label"
              style={inputS}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="es. Priority"
              required
            />
          </div>
          <div>
            <label htmlFor="enum-scope" style={labelS}>Scope</label>
            <select
              id="enum-scope"
              style={inputS}
              value={scope}
              onChange={(e) => setScope(e.target.value as 'shared' | 'itil' | 'cmdb')}
            >
              <option value="shared">Condiviso</option>
              <option value="itil">ITIL</option>
              <option value="cmdb">CMDB</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" style={btnSecondary} onClick={onClose}>Annulla</button>
            <button type="submit" style={btnPrimary} disabled={loading}>
              <Plus size={14} aria-hidden="true" /> Crea
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── EnumEditor ────────────────────────────────────────────────────────────────

function EnumEditor({ enumType: e, onDeleted }: { enumType: EnumType; onDeleted: () => void }) {
  const [label, setLabel]   = useState(e.label)
  const [scope, setScope]   = useState(e.scope)
  const [values, setValues] = useState<string[]>(e.values)
  const [newVal, setNewVal] = useState('')
  const [dirty, setDirty]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [updateEnum, { loading: saving }] = useMutation(UPDATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => { toast.success('Enum aggiornato'); setDirty(false) },
    onError: (err) => toast.error(err.message),
  })

  const [deleteEnum, { loading: deleting }] = useMutation(DELETE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => { toast.success('Enum eliminato'); onDeleted() },
    onError: (err) => toast.error(err.message),
  })

  const setDirtyLabel = (v: string) => { setLabel(v); setDirty(true) }
  const setDirtyScope = (v: string) => { setScope(v); setDirty(true) }

  const addValue = () => {
    const v = newVal.trim()
    if (!v || values.includes(v)) return
    setValues((prev) => [...prev, v])
    setNewVal('')
    setDirty(true)
  }

  const removeValue = (v: string) => {
    setValues((prev) => prev.filter((x) => x !== v))
    setDirty(true)
  }

  const handleSave = () => {
    void updateEnum({ variables: { id: e.id, input: { label, values, scope: e.isSystem ? undefined : scope } } })
  }

  const handleCancel = () => {
    setLabel(e.label)
    setScope(e.scope)
    setValues(e.values)
    setDirty(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Tag size={18} style={{ color: 'var(--color-brand)' }} aria-hidden="true" />
        <h2 style={{ fontSize: 17, fontWeight: 600 }}>{e.label}</h2>
        {e.isSystem && (
          <span style={{
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
            background: '#f0f4ff', color: 'var(--color-brand)', padding: '2px 8px',
            borderRadius: 20, fontWeight: 500,
          }}>
            <Lock size={10} aria-hidden="true" /> Sistema
          </span>
        )}
      </div>

      {e.isSystem && (
        <p style={{
          fontSize: 12, color: 'var(--color-slate)', background: '#f8fafc',
          padding: '10px 14px', borderRadius: 6, margin: 0,
        }}>
          Enum di sistema — puoi aggiungere valori ma non eliminare l'enum.
        </p>
      )}

      {/* Nome (readonly) */}
      <div>
        <label htmlFor="editor-name" style={labelS}>Nome (tecnico)</label>
        <input
          id="editor-name"
          style={{ ...inputS, background: '#f8fafc', color: '#8892a4' }}
          value={e.name}
          readOnly
        />
      </div>

      {/* Label */}
      <div>
        <label htmlFor="editor-label" style={labelS}>Label</label>
        <input
          id="editor-label"
          style={inputS}
          value={label}
          onChange={(ev) => setDirtyLabel(ev.target.value)}
        />
      </div>

      {/* Scope */}
      <div>
        <label htmlFor="editor-scope" style={labelS}>Scope</label>
        <select
          id="editor-scope"
          style={{ ...inputS, ...(e.isSystem ? { background: '#f8fafc', color: '#8892a4' } : {}) }}
          value={scope}
          onChange={(ev) => setDirtyScope(ev.target.value)}
          disabled={e.isSystem}
        >
          <option value="shared">Condiviso</option>
          <option value="itil">ITIL</option>
          <option value="cmdb">CMDB</option>
        </select>
      </div>

      {/* Valori */}
      <div>
        <label style={labelS}>Valori</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, minHeight: 32 }}>
          {values.map((v) => (
            <span
              key={v}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', background: '#f0f4ff', borderRadius: 20,
                fontSize: 12, color: 'var(--color-brand)', fontWeight: 500,
              }}
            >
              {v}
              <button
                type="button"
                onClick={() => removeValue(v)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  display: 'flex', color: '#8892a4', lineHeight: 1,
                }}
                aria-label={`Rimuovi valore ${v}`}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
          {values.length === 0 && (
            <span style={{ fontSize: 12, color: '#8892a4' }}>Nessun valore</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputS, flex: 1 }}
            value={newVal}
            onChange={(ev) => setNewVal(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addValue() } }}
            placeholder="Aggiungi valore…"
            aria-label="Nuovo valore enum"
          />
          <button type="button" style={btnPrimary} onClick={addValue} aria-label="Aggiungi valore">
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid #f1f3f9' }}>
        {dirty && (
          <>
            <button type="button" style={btnPrimary} onClick={handleSave} disabled={saving}>
              <Save size={14} aria-hidden="true" /> Salva
            </button>
            <button type="button" style={btnSecondary} onClick={handleCancel}>
              Annulla
            </button>
          </>
        )}
        {!e.isSystem && (
          <div style={{ marginLeft: 'auto' }}>
            {!confirmDelete ? (
              <button type="button" style={btnDanger} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} aria-hidden="true" /> Elimina
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#ef4444' }}>Conferma eliminazione?</span>
                <button
                  type="button"
                  style={{ ...btnDanger, fontWeight: 600 }}
                  onClick={() => { void deleteEnum({ variables: { id: e.id } }) }}
                  disabled={deleting}
                >
                  Sì, elimina
                </button>
                <button type="button" style={btnSecondary} onClick={() => setConfirmDelete(false)}>
                  No
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function EnumDesignerPage() {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const { data, loading } = useQuery<{ enumTypes: EnumType[] }>(GET_ENUM_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  const allEnums: EnumType[] = data?.enumTypes ?? []

  // Group by scope
  const groups: Record<string, EnumType[]> = {}
  for (const e of allEnums) {
    const g = SCOPE_LABELS[e.scope] ?? e.scope
    if (!groups[g]) groups[g] = []
    groups[g]!.push(e)
  }

  const selected = allEnums.find((e) => e.id === selectedId) ?? null

  const handleCreated = (e: EnumType) => {
    setShowCreate(false)
    setSelectedId(e.id)
  }

  // suppress unused warning — t is used for i18n readiness
  void t

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Left panel */}
      <div style={{
        width: 280, borderRight: '1px solid #f1f3f9', display: 'flex',
        flexDirection: 'column', background: '#fff', flexShrink: 0,
      }}>
        <div style={{
          padding: '16px 16px 12px', borderBottom: '1px solid #f1f3f9',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <h1 style={{ fontSize: 15, fontWeight: 600 }}>Dictionary Designer</h1>
          <button
            type="button"
            style={{ ...btnPrimary, padding: '5px 10px', fontSize: 12 }}
            onClick={() => setShowCreate(true)}
            aria-label="Nuovo enum type"
          >
            <Plus size={13} aria-hidden="true" /> Nuovo
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loading && !allEnums.length && (
            <p style={{ padding: '20px 16px', fontSize: 12, color: '#8892a4' }}>Caricamento…</p>
          )}
          {Object.entries(groups).map(([groupName, items]) => (
            <div key={groupName}>
              <div style={{
                padding: '8px 16px 4px', fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.5px', color: '#8892a4',
              }}>
                {groupName}
              </div>
              {items.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedId(e.id)}
                  style={{
                    width: '100%', textAlign: 'left', padding: '8px 16px',
                    background: selectedId === e.id ? '#f0f4ff' : 'transparent',
                    border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                    borderLeft: selectedId === e.id ? '3px solid var(--color-brand)' : '3px solid transparent',
                  }}
                  aria-current={selectedId === e.id ? 'true' : undefined}
                >
                  {e.isSystem && (
                    <Lock size={11} style={{ color: '#8892a4', flexShrink: 0 }} aria-hidden="true" />
                  )}
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--color-slate-dark)' }}>
                    {e.label}
                  </span>
                  <span style={{ fontSize: 11, color: '#8892a4' }}>
                    {e.values.length}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 32 }}>
        {selected ? (
          <EnumEditor
            key={selected.id}
            enumType={selected}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: '#8892a4', fontSize: 14,
          }}>
            Seleziona un enum dalla lista o creane uno nuovo
          </div>
        )}
      </div>

      {/* Create dialog */}
      {showCreate && (
        <CreateEnumDialog
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}
