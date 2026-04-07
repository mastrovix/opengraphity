import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Zap, Plus, Pencil, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { GET_AUTO_TRIGGERS } from '@/graphql/queries'
import { CREATE_AUTO_TRIGGER, UPDATE_AUTO_TRIGGER, DELETE_AUTO_TRIGGER } from '@/graphql/mutations'
import {
  inputS, selectS, labelS, btnPrimary, btnSecondary,
} from '@/pages/settings/shared/designerStyles'
import { ActionParamsEditor } from '@/components/ActionParamsEditor'
import { ConditionRowEditor } from '@/components/ConditionRowEditor'
import { AutomationPreview } from '@/components/AutomationPreview'

// ── Constants ────────────────────────────────────────────────────────────────

const ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request'] as const
const EVENT_TYPES  = ['on_create', 'on_update', 'on_timer', 'on_sla_breach', 'on_field_change'] as const
// Operators now handled by ConditionRowEditor component
const ACTION_TYPES = ['set_field', 'assign_team', 'assign_user', 'transition_workflow', 'create_notification', 'create_comment', 'set_priority'] as const

const EVENT_LABELS: Record<string, string> = {
  on_create: 'creato', on_update: 'aggiornato', on_timer: 'dopo timer',
  on_sla_breach: 'SLA violato', on_field_change: 'campo modificato',
}
const ACTION_LABELS: Record<string, string> = {
  set_field: 'Imposta campo', assign_team: 'Assegna team', assign_user: 'Assegna utente',
  transition_workflow: 'Transizione workflow', create_notification: 'Crea notifica',
  create_comment: 'Crea commento', set_priority: 'Imposta priorità',
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Condition { field: string; operator: string; value: string }
interface TriggerAction { type: string; params: Record<string, string> }
interface AutoTrigger {
  id: string; name: string; entityType: string; eventType: string
  timerDelayMinutes: number | null; conditions: string; actions: string
  enabled: boolean; executionCount: number; lastExecutedAt: string | null
}

type FormData = {
  name: string; entityType: string; eventType: string
  timerDelayMinutes: number; conditions: Condition[]; actions: TriggerAction[]
  enabled: boolean
}

const emptyForm = (): FormData => ({
  name: '', entityType: 'incident', eventType: 'on_create',
  timerDelayMinutes: 0, conditions: [], actions: [], enabled: true,
})

// ── Styles ───────────────────────────────────────────────────────────────────

const thS: React.CSSProperties = {
  textAlign: 'left', padding: '10px 14px', fontSize: 12, fontWeight: 600,
  color: 'var(--color-slate)', borderBottom: '2px solid #e5e7eb',
}
const tdS: React.CSSProperties = {
  padding: '10px 14px', fontSize: 13, color: 'var(--color-slate-dark)',
  borderBottom: '1px solid #f3f4f6',
}
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 9000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const modal: React.CSSProperties = {
  background: '#fff', borderRadius: 12, width: 680, maxHeight: '90vh',
  overflow: 'auto', padding: '28px 32px', boxShadow: '0 20px 60px rgba(0,0,0,.18)',
}
const chipRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6,
}
const addBtn: React.CSSProperties = {
  ...btnSecondary, fontSize: 12, padding: '4px 10px', marginTop: 4,
}
const removeBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger, #ef4444)', padding: 2,
}
const toggleTrack = (on: boolean): React.CSSProperties => ({
  width: 36, height: 20, borderRadius: 10, cursor: 'pointer', border: 'none',
  background: on ? 'var(--color-brand)' : '#d1d5db', position: 'relative', transition: 'background .2s',
})
const toggleKnob = (on: boolean): React.CSSProperties => ({
  position: 'absolute', top: 2, left: on ? 18 : 2,
  width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .2s',
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) } catch { return fallback }
}

// Preview text now handled by AutomationPreview component

// Action param fields — now handled by ActionParamsEditor component

// ── Toggle Component ─────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" style={toggleTrack(value)} onClick={() => onChange(!value)}>
      <span style={toggleKnob(value)} />
    </button>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export function AutoTriggersPage() {
  const [editing, setEditing]       = useState<AutoTrigger | null>(null)
  const [creating, setCreating]     = useState(false)
  const [deleteId, setDeleteId]     = useState<string | null>(null)
  const [form, setForm]             = useState<FormData>(emptyForm())

  const { data, loading, refetch } = useQuery<{ autoTriggers: AutoTrigger[] }>(GET_AUTO_TRIGGERS)
  const triggers: AutoTrigger[] = data?.autoTriggers ?? []

  const [createTrigger] = useMutation(CREATE_AUTO_TRIGGER, { onCompleted: () => { toast.success('Trigger creato'); refetch(); closeModal() } })
  const [updateTrigger] = useMutation(UPDATE_AUTO_TRIGGER, { onCompleted: () => { toast.success('Trigger aggiornato'); refetch(); closeModal() } })
  const [deleteTrigger] = useMutation(DELETE_AUTO_TRIGGER, { onCompleted: () => { toast.success('Trigger eliminato'); refetch(); setDeleteId(null) } })

  function closeModal() { setEditing(null); setCreating(false) }

  function openCreate() {
    setForm(emptyForm())
    setCreating(true)
  }
  function openEdit(t: AutoTrigger) {
    setForm({
      name: t.name, entityType: t.entityType, eventType: t.eventType,
      timerDelayMinutes: t.timerDelayMinutes ?? 0,
      conditions: parseJSON<Condition[]>(t.conditions, []),
      actions: parseJSON<TriggerAction[]>(t.actions, []),
      enabled: t.enabled,
    })
    setEditing(t)
  }

  function handleSave() {
    if (!form.name.trim()) { toast.error('Nome obbligatorio'); return }
    if (editing) {
      updateTrigger({ variables: { id: editing.id, input: {
        name: form.name, eventType: form.eventType,
        timerDelayMinutes: form.eventType === 'on_timer' ? form.timerDelayMinutes : null,
        conditions: JSON.stringify(form.conditions),
        actions: JSON.stringify(form.actions),
        enabled: form.enabled,
      } } })
    } else {
      createTrigger({ variables: { input: {
        name: form.name, entityType: form.entityType, eventType: form.eventType,
        timerDelayMinutes: form.eventType === 'on_timer' ? form.timerDelayMinutes : null,
        conditions: JSON.stringify(form.conditions),
        actions: JSON.stringify(form.actions),
        enabled: form.enabled,
      } } })
    }
  }

  function handleToggleEnabled(t: AutoTrigger) {
    updateTrigger({ variables: { id: t.id, input: { enabled: !t.enabled } } })
  }

  // ── Condition helpers ──────────────────────────────────────────────────────
  const addCondition = () => setForm(p => ({ ...p, conditions: [...p.conditions, { field: '', operator: 'equals', value: '' }] }))
  const removeCondition = (i: number) => setForm(p => ({ ...p, conditions: p.conditions.filter((_, idx) => idx !== i) }))
  const setCondition = (i: number, patch: Partial<Condition>) => setForm(p => ({ ...p, conditions: p.conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c) }))

  // ── Action helpers ─────────────────────────────────────────────────────────
  const addAction = () => setForm(p => ({ ...p, actions: [...p.actions, { type: 'set_field', params: {} }] }))
  const removeAction = (i: number) => setForm(p => ({ ...p, actions: p.actions.filter((_, idx) => idx !== i) }))
  const setAction = (i: number, patch: Partial<TriggerAction>) => setForm(p => ({ ...p, actions: p.actions.map((a, idx) => idx === i ? { ...a, ...patch } : a) }))
  const setActionParam = (i: number, key: string, val: string) =>
    setForm(p => ({ ...p, actions: p.actions.map((a, idx) => idx === i ? { ...a, params: { ...a.params, [key]: val } } : a) }))

  const isModalOpen = creating || !!editing

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <PageTitle icon={<Zap size={22} color="var(--color-brand)" />}>Auto Trigger</PageTitle>
        <button style={btnPrimary} onClick={openCreate}><Plus size={15} /> Nuovo Trigger</button>
      </div>

      {loading && <p style={{ color: 'var(--color-slate)', fontSize: 13 }}>Caricamento...</p>}

      {!loading && triggers.length === 0 && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-slate)' }}>
          <Zap size={40} style={{ marginBottom: 12, opacity: .4 }} />
          <p style={{ fontSize: 14 }}>Nessun trigger configurato</p>
          <button style={{ ...btnPrimary, marginTop: 12 }} onClick={openCreate}><Plus size={14} /> Crea il primo</button>
        </div>
      )}

      {!loading && triggers.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thS}>Nome</th>
                <th style={thS}>Entità</th>
                <th style={thS}>Evento</th>
                <th style={thS}>Abilitato</th>
                <th style={thS}>Esecuzioni</th>
                <th style={thS}>Ultima esecuzione</th>
                <th style={{ ...thS, textAlign: 'right' }}>Azioni</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((t: AutoTrigger) => (
                <tr key={t.id} style={{ transition: 'background .15s' }} onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                  <td style={{ ...tdS, fontWeight: 500 }}>{t.name}</td>
                  <td style={tdS}>{t.entityType}</td>
                  <td style={tdS}>{EVENT_LABELS[t.eventType] || t.eventType}</td>
                  <td style={tdS}><Toggle value={t.enabled} onChange={() => handleToggleEnabled(t)} /></td>
                  <td style={tdS}>{t.executionCount}</td>
                  <td style={tdS}>{t.lastExecutedAt ? new Date(t.lastExecutedAt).toLocaleString('it-IT') : '—'}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>
                    <button style={{ ...btnSecondary, padding: '4px 8px', marginRight: 4 }} onClick={() => openEdit(t)}><Pencil size={14} /></button>
                    <button style={{ ...btnSecondary, padding: '4px 8px', color: 'var(--color-danger, #ef4444)', borderColor: '#fecaca' }} onClick={() => setDeleteId(t.id)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Create / Edit Modal ─────────────────────────────────────────────── */}
      {isModalOpen && createPortal(
        <div style={overlay} onClick={closeModal}>
          <div style={modal} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 18, color: 'var(--color-slate-dark)' }}>{editing ? 'Modifica Trigger' : 'Nuovo Trigger'}</h3>
              <button style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={closeModal}><X size={20} color="var(--color-slate)" /></button>
            </div>

            {/* Name */}
            <label style={labelS}>Nome</label>
            <input style={inputS} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="es. Auto-assign P1 incidents" />

            {/* Entity + Event */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
              <div>
                <label style={labelS}>Tipo entità</label>
                <select style={selectS} value={form.entityType} onChange={e => setForm(p => ({ ...p, entityType: e.target.value }))}>
                  {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelS}>Tipo evento</label>
                <select style={selectS} value={form.eventType} onChange={e => setForm(p => ({ ...p, eventType: e.target.value }))}>
                  {EVENT_TYPES.map(t => <option key={t} value={t}>{EVENT_LABELS[t] || t}</option>)}
                </select>
              </div>
            </div>

            {/* Timer delay */}
            {form.eventType === 'on_timer' && (
              <div style={{ marginTop: 14 }}>
                <label style={labelS}>Ritardo timer (minuti)</label>
                <input style={{ ...inputS, width: 120 }} type="number" min={0} value={form.timerDelayMinutes} onChange={e => setForm(p => ({ ...p, timerDelayMinutes: Number(e.target.value) }))} />
              </div>
            )}

            {/* Conditions */}
            <div style={{ marginTop: 20 }}>
              <label style={{ ...labelS, fontSize: 13, fontWeight: 600 }}>Condizioni</label>
              {form.conditions.map((c, i) => (
                <ConditionRowEditor
                  key={i}
                  condition={c}
                  entityType={form.entityType}
                  onChange={patch => setCondition(i, patch)}
                  onRemove={() => removeCondition(i)}
                />
              ))}
              <button style={addBtn} onClick={addCondition}><Plus size={12} /> Aggiungi condizione</button>
            </div>

            {/* Actions */}
            <div style={{ marginTop: 20 }}>
              <label style={{ ...labelS, fontSize: 13, fontWeight: 600 }}>Azioni</label>
              {form.actions.map((a, i) => (
                <div key={i} style={{ ...chipRow, flexWrap: 'wrap' }}>
                  <select style={{ ...selectS, width: 180 }} value={a.type} onChange={e => setAction(i, { type: e.target.value, params: {} })}>
                    {ACTION_TYPES.map(at => <option key={at} value={at}>{ACTION_LABELS[at]}</option>)}
                  </select>
                  <ActionParamsEditor
                    actionType={a.type}
                    params={a.params as Record<string, string>}
                    entityType={form.entityType}
                    onChange={(key, val) => setActionParam(i, key, val)}
                  />
                  <button style={removeBtn} onClick={() => removeAction(i)}><X size={14} /></button>
                </div>
              ))}
              <button style={addBtn} onClick={addAction}><Plus size={12} /> Aggiungi azione</button>
            </div>

            {/* Enabled toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
              <label style={{ ...labelS, margin: 0 }}>Abilitato</label>
              <Toggle value={form.enabled} onChange={v => setForm(p => ({ ...p, enabled: v }))} />
            </div>

            {/* Preview */}
            <AutomationPreview
              entityType={form.entityType}
              eventType={form.eventType}
              conditions={form.conditions}
              actions={form.actions}
              timerMinutes={form.eventType === 'on_timer' ? form.timerDelayMinutes : null}
            />

            {/* Footer buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
              <button style={btnSecondary} onClick={closeModal}>Annulla</button>
              <button style={btnPrimary} onClick={handleSave}>{editing ? 'Salva modifiche' : 'Crea trigger'}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Delete confirmation ─────────────────────────────────────────────── */}
      {deleteId && createPortal(
        <div style={overlay} onClick={() => setDeleteId(null)}>
          <div style={{ ...modal, width: 420, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
            <Trash2 size={32} color="var(--color-danger, #ef4444)" style={{ marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--color-slate-dark)' }}>Eliminare questo trigger?</h3>
            <p style={{ fontSize: 13, color: 'var(--color-slate)', marginBottom: 20 }}>Questa azione non puo essere annullata.</p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
              <button style={btnSecondary} onClick={() => setDeleteId(null)}>Annulla</button>
              <button style={{ ...btnPrimary, background: 'var(--color-danger, #ef4444)' }} onClick={() => deleteTrigger({ variables: { id: deleteId } })}>Elimina</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </PageContainer>
  )
}
