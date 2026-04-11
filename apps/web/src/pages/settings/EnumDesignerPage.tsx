import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { Lock, LockOpen, Plus, X, Save, Trash2, Tag } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
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
  borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}
const labelS: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: '#fff', fontSize: 'var(--font-size-body)', fontWeight: 500, cursor: 'pointer',
}
const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', cursor: 'pointer',
}
const btnDanger: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '6px 12px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: '#ef4444', fontSize: 'var(--font-size-body)', cursor: 'pointer',
}

// ── CreateEnumDialog ──────────────────────────────────────────────────────────

function CreateEnumDialog({
  onClose,
  onCreated,
}: { onClose: () => void; onCreated: (e: EnumType) => void }) {
  const { t } = useTranslation()
  const [name, setName]   = useState('')
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<'shared' | 'itil' | 'cmdb'>('shared')

  const [createEnum, { loading }] = useMutation(CREATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: (d: unknown) => {
      const result = (d as { createEnumType: EnumType }).createEnumType
      toast.success(t('pages.dictionary.created', { label: result.label }))
      onCreated(result)
    },
    onError: (e) => toast.error(e.message),
  })

  const handleSubmit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!name.match(/^[a-z][a-z0-9_]*$/)) {
      toast.error(t('pages.dictionary.invalidName'))
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
        <h2 id="create-enum-title" style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, marginBottom: 20 }}>
          {t('pages.dictionary.createTitle')}
        </h2>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label htmlFor="enum-name" style={labelS}>{t('pages.dictionary.nameFieldLabel')}</label>
            <input
              id="enum-name"
              style={inputS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('pages.dictionary.namePlaceholder')}
              required
              pattern="[a-z][a-z0-9_]*"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="enum-label" style={labelS}>{t('pages.dictionary.labelLabel')}</label>
            <input
              id="enum-label"
              style={inputS}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('pages.dictionary.labelPlaceholder')}
              required
            />
          </div>
          <div>
            <label htmlFor="enum-scope" style={labelS}>{t('pages.dictionary.scopeLabel')}</label>
            <select
              id="enum-scope"
              style={inputS}
              value={scope}
              onChange={(e) => setScope(e.target.value as 'shared' | 'itil' | 'cmdb')}
            >
              <option value="shared">{t('pages.dictionary.scopeShared')}</option>
              <option value="itil">{t('pages.dictionary.scopeItil')}</option>
              <option value="cmdb">{t('pages.dictionary.scopeCmdb')}</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" style={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" style={btnPrimary} disabled={loading}>
              <Plus size={14} aria-hidden="true" /> {t('common.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── EnumEditor ────────────────────────────────────────────────────────────────

function EnumEditor({ enumType: e, onDeleted }: { enumType: EnumType; onDeleted: () => void }) {
  const { t } = useTranslation()
  const [label, setLabel]   = useState(e.label)
  const [scope, setScope]   = useState(e.scope)
  const [values, setValues] = useState<string[]>(e.values)
  const [newVal, setNewVal] = useState('')
  const [dirty, setDirty]   = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [updateEnum, { loading: saving }] = useMutation(UPDATE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => { toast.success(t('pages.dictionary.updated')); setDirty(false) },
    onError: (err) => toast.error(err.message),
  })

  const [deleteEnum, { loading: deleting }] = useMutation(DELETE_ENUM_TYPE, {
    refetchQueries: [GET_ENUM_TYPES],
    onCompleted: () => { toast.success(t('pages.dictionary.deleted')); onDeleted() },
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
        <h2 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600 }}>{e.label}</h2>
        {e.isSystem && (
          <span style={{
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-table)',
            background: '#f0f4ff', color: 'var(--color-brand)', padding: '2px 8px',
            borderRadius: 20, fontWeight: 500,
          }}>
            <Lock size={10} aria-hidden="true" /> {t('pages.dictionary.systemBadge')}
          </span>
        )}
      </div>

      {e.isSystem && (
        <p style={{
          fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', background: '#f8fafc',
          padding: '10px 14px', borderRadius: 6, margin: 0,
        }}>
          {t('pages.dictionary.systemNote')}
        </p>
      )}

      {/* Nome (readonly) */}
      <div>
        <label htmlFor="editor-name" style={labelS}>{t('pages.dictionary.nameLabel')}</label>
        <input
          id="editor-name"
          style={{ ...inputS, background: '#f8fafc', color: '#8892a4' }}
          value={e.name}
          readOnly
        />
      </div>

      {/* Label */}
      <div>
        <label htmlFor="editor-label" style={labelS}>{t('pages.dictionary.labelLabel')}</label>
        <input
          id="editor-label"
          style={inputS}
          value={label}
          onChange={(ev) => setDirtyLabel(ev.target.value)}
        />
      </div>

      {/* Scope */}
      <div>
        <label htmlFor="editor-scope" style={labelS}>{t('pages.dictionary.scopeLabel')}</label>
        <select
          id="editor-scope"
          style={{ ...inputS, ...(e.isSystem ? { background: '#f8fafc', color: '#8892a4' } : {}) }}
          value={scope}
          onChange={(ev) => setDirtyScope(ev.target.value)}
          disabled={e.isSystem}
        >
          <option value="shared">{t('pages.dictionary.scopeShared')}</option>
          <option value="itil">{t('pages.dictionary.scopeItil')}</option>
          <option value="cmdb">{t('pages.dictionary.scopeCmdb')}</option>
        </select>
      </div>

      {/* Values */}
      <div>
        <label style={labelS}>{t('pages.dictionary.valuesLabel')}</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, minHeight: 32 }}>
          {values.map((v) => (
            <span
              key={v}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 10px', background: '#f0f4ff', borderRadius: 20,
                fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500,
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
                aria-label={t('pages.dictionary.removeValueLabel', { value: v })}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
          {values.length === 0 && (
            <span style={{ fontSize: 'var(--font-size-body)', color: '#8892a4' }}>{t('pages.dictionary.noValues')}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputS, flex: 1 }}
            value={newVal}
            onChange={(ev) => setNewVal(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addValue() } }}
            placeholder={t('pages.dictionary.addValuePlaceholder')}
            aria-label={t('pages.dictionary.addValueLabel')}
          />
          <button type="button" style={btnPrimary} onClick={addValue} aria-label={t('pages.dictionary.addValueLabel')}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid #f1f3f9' }}>
        {dirty && (
          <>
            <button type="button" style={btnPrimary} onClick={handleSave} disabled={saving}>
              <Save size={14} aria-hidden="true" /> {t('common.save')}
            </button>
            <button type="button" style={btnSecondary} onClick={handleCancel}>
              {t('common.cancel')}
            </button>
          </>
        )}
        {!e.isSystem && (
          <div style={{ marginLeft: 'auto' }}>
            {!confirmDelete ? (
              <button type="button" style={btnDanger} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} aria-hidden="true" /> {t('common.delete')}
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: '#ef4444' }}>{t('pages.dictionary.confirmDelete')}</span>
                <button
                  type="button"
                  style={{ ...btnDanger, fontWeight: 600 }}
                  onClick={() => { void deleteEnum({ variables: { id: e.id } }) }}
                  disabled={deleting}
                >
                  {t('pages.dictionary.confirmYes')}
                </button>
                <button type="button" style={btnSecondary} onClick={() => setConfirmDelete(false)}>
                  {t('common.no')}
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

  // Group by scope (use i18n scope labels)
  const SCOPE_LABELS: Record<string, string> = {
    shared: t('pages.dictionary.scopeShared'),
    itil:   t('pages.dictionary.scopeItil'),
    cmdb:   t('pages.dictionary.scopeCmdb'),
  }

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

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Tag size={22} color="var(--color-brand)" />}>
          {t('pages.dictionary.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
          {t('pages.dictionary.subtitle')}
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start' }}>
        {/* Left: enum list */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
            <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{t('pages.dictionary.listHeader')}</span>
            <button
              type="button"
              style={{ ...btnPrimary, padding: '4px 10px', fontSize: 'var(--font-size-body)' }}
              onClick={() => setShowCreate(true)}
              aria-label={t('pages.dictionary.createTitle')}
            >
              <Plus size={12} aria-hidden="true" /> {t('pages.dictionary.newButton')}
            </button>
          </div>

          <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
            {loading && !allEnums.length && (
              <p style={{ padding: '20px 16px', fontSize: 'var(--font-size-body)', color: '#8892a4' }}>{t('pages.dictionary.loading')}</p>
            )}
            {Object.entries(groups).map(([groupName, items]) => (
              <div key={groupName}>
                <div style={{
                  padding: '5px 16px 4px', fontSize: 'var(--font-size-label)', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  color: '#94a3b8', background: '#f9fafb',
                  borderBottom: '1px solid #f3f4f6',
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
                      background: selectedId === e.id ? '#f0f9ff' : 'transparent',
                      border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                      borderLeft: selectedId === e.id ? '3px solid var(--color-brand)' : '3px solid transparent',
                      borderBottom: '1px solid #f3f4f6',
                    }}
                    aria-current={selectedId === e.id ? 'true' : undefined}
                  >
                    {e.isSystem
                      ? <Lock     size={11} style={{ color: 'var(--color-brand)', flexShrink: 0 }} aria-hidden="true" />
                      : <LockOpen size={11} style={{ color: '#8892a4', flexShrink: 0 }} aria-hidden="true" />
                    }
                    <span style={{ flex: 1, fontSize: 'var(--font-size-body)', fontWeight: selectedId === e.id ? 600 : 500, color: selectedId === e.id ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {e.label}
                    </span>
                    <span style={{ fontSize: 'var(--font-size-label)', color: '#94a3b8', flexShrink: 0 }}>
                      {e.values.length}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Right: editor */}
        <div>
          {selected ? (
            <EnumEditor
              key={selected.id}
              enumType={selected}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <div style={{
              background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
              padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 'var(--font-size-body)',
            }}>
              {t('common.noResults')}
            </div>
          )}
        </div>
      </div>

      {/* Create dialog */}
      {showCreate && (
        <CreateEnumDialog
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </PageContainer>
  )
}
