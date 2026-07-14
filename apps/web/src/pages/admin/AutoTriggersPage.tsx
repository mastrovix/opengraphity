import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Zap, Plus, Pencil, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { GET_AUTO_TRIGGERS } from '@/graphql/queries'
import { CREATE_AUTO_TRIGGER, UPDATE_AUTO_TRIGGER, DELETE_AUTO_TRIGGER } from '@/graphql/mutations'
import {
  inputS, selectS, labelS, btnPrimary, btnSecondary,
} from '@/pages/settings/shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { ActionParamsEditor } from '@/components/ActionParamsEditor'
import { ConditionRowEditor } from '@/components/ConditionRowEditor'
import { AutomationPreview } from '@/components/AutomationPreview'

// ── Constants ────────────────────────────────────────────────────────────────

import { ITIL_ENTITY_TYPES as ENTITY_TYPES } from '@/constants'
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

const chipRow: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6,
}
const addBtn: React.CSSProperties = {
  ...btnSecondary, fontSize: 'var(--font-size-body)', padding: '4px 10px', marginTop: 4,
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

  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const handleSort = (f: string, d: 'asc' | 'desc') => { setSortField(f); setSortDir(d) }

  const TRIGGER_FILTER_FIELDS: FieldConfig[] = [
    { key: 'entityType', label: 'Tipo entità', type: 'enum', options: [
      { value: 'incident', label: 'Incident' }, { value: 'change', label: 'Change' },
      { value: 'problem', label: 'Problem' }, { value: 'service_request', label: 'Service Request' },
    ]},
    { key: 'eventType', label: 'Tipo evento', type: 'enum', options: [
      { value: 'on_create', label: 'Creazione' }, { value: 'on_update', label: 'Aggiornamento' },
      { value: 'on_timer', label: 'Timer' }, { value: 'on_sla_breach', label: 'SLA Breach' },
      { value: 'on_field_change', label: 'Cambio campo' },
    ]},
    { key: 'enabled', label: 'Abilitato', type: 'enum', options: [
      { value: 'true', label: 'Sì' }, { value: 'false', label: 'No' },
    ]},
    { key: 'name', label: 'Nome', type: 'text' },
  ]

  const { data, loading, refetch } = useQuery<{ autoTriggers: AutoTrigger[] }>(GET_AUTO_TRIGGERS, {
    variables: { sortField, sortDirection: sortDir, filters: filterGroup ? JSON.stringify(filterGroup) : null },
  })
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

  const triggerColumns: ColumnDef<AutoTrigger>[] = [
    { key: 'name', label: 'Nome', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
    { key: 'entityType', label: 'Entità', sortable: true },
    { key: 'eventType', label: 'Evento', sortable: true, render: (v) => EVENT_LABELS[String(v)] || String(v) },
    { key: 'enabled', label: 'Abilitato', sortable: true, render: (_v, row) => <Toggle value={row.enabled} onChange={() => handleToggleEnabled(row)} /> },
    { key: 'executionCount', label: 'Esecuzioni', sortable: true },
    { key: 'lastExecutedAt', label: 'Ultima esecuzione', sortable: true, render: (v) => v ? new Date(String(v)).toLocaleString('it-IT') : '—' },
    { key: 'id', label: 'Azioni', sortable: true, render: (_v, row) => (
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button style={{ ...btnSecondary, padding: '4px 8px' }} onClick={() => openEdit(row)}><Pencil size={14} /></button>
        <button style={{ ...btnSecondary, padding: '4px 8px', color: 'var(--color-danger, #ef4444)', borderColor: '#fecaca' }} onClick={() => setDeleteId(row.id)}><Trash2 size={14} /></button>
      </div>
    ) },
  ]

  const isModalOpen = creating || !!editing

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Zap size={22} color="var(--color-icon-accent)" />}>Auto Trigger</PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${triggers.length} trigger`}
          </p>
        </div>
        <button style={btnPrimary} onClick={openCreate}><Plus size={15} /> Nuovo Trigger</button>
      </div>

      <FilterBuilder fields={TRIGGER_FILTER_FIELDS} onApply={g => setFilterGroup(g)} />

      {!loading && triggers.length === 0 && (
        <EmptyState
          icon={<Zap size={32} color="var(--color-slate-light)" />}
          title="Nessun trigger configurato"
        />
      )}

      {!loading && triggers.length > 0 && (
        <SortableFilterTable<AutoTrigger>
          columns={triggerColumns}
          data={triggers}
          onSort={handleSort}
          sortField={sortField}
          sortDir={sortDir}
          loading={false}
          label="Auto Triggers"
        />
      )}

      {/* ── Create / Edit Modal ─────────────────────────────────────────────── */}
      {isModalOpen && createPortal(
        <Modal
          open
          onClose={closeModal}
          title={editing ? 'Modifica Trigger' : 'Nuovo Trigger'}
          width={680}
          zIndex={9000}
          footer={
            <>
              <Button variant="secondary" onClick={closeModal} style={{ padding: '7px 14px' }}>Annulla</Button>
              <Button onClick={handleSave}>{editing ? 'Salva modifiche' : 'Crea trigger'}</Button>
            </>
          }
        >
            {/* Name */}
            <label style={labelS}>Nome</label>
            <Input style={inputS} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="es. Auto-assign P1 incidents" />

            {/* Entity + Event */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
              <div>
                <label style={labelS}>Tipo entità</label>
                <Select style={selectS} value={form.entityType} onChange={e => setForm(p => ({ ...p, entityType: e.target.value }))}>
                  {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </Select>
              </div>
              <div>
                <label style={labelS}>Tipo evento</label>
                <Select style={selectS} value={form.eventType} onChange={e => setForm(p => ({ ...p, eventType: e.target.value }))}>
                  {EVENT_TYPES.map(t => <option key={t} value={t}>{EVENT_LABELS[t] || t}</option>)}
                </Select>
              </div>
            </div>

            {/* Timer delay */}
            {form.eventType === 'on_timer' && (
              <div style={{ marginTop: 14 }}>
                <label style={labelS}>Ritardo timer (minuti)</label>
                <Input style={{ ...inputS, width: 120 }} type="number" min={0} value={form.timerDelayMinutes} onChange={e => setForm(p => ({ ...p, timerDelayMinutes: Number(e.target.value) }))} />
              </div>
            )}

            {/* Conditions */}
            <div style={{ marginTop: 20 }}>
              <label style={{ ...labelS, fontSize: 'var(--font-size-body)', fontWeight: 600 }}>Condizioni</label>
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
              <label style={{ ...labelS, fontSize: 'var(--font-size-body)', fontWeight: 600 }}>Azioni</label>
              {form.actions.map((a, i) => (
                <div key={i} style={{ ...chipRow, flexWrap: 'wrap' }}>
                  <Select style={{ ...selectS, width: 180 }} value={a.type} onChange={e => setAction(i, { type: e.target.value, params: {} })}>
                    {ACTION_TYPES.map(at => <option key={at} value={at}>{ACTION_LABELS[at]}</option>)}
                  </Select>
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
        </Modal>,
        document.body,
      )}

      {/* ── Delete confirmation ─────────────────────────────────────────────── */}
      {deleteId && createPortal(
        <Modal
          open
          onClose={() => setDeleteId(null)}
          title="Eliminare questo trigger?"
          width={420}
          zIndex={9000}
          footerStyle={{ justifyContent: 'center', gap: 10 }}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleteId(null)} style={{ padding: '7px 14px' }}>Annulla</Button>
              <Button onClick={() => deleteTrigger({ variables: { id: deleteId } })} style={{ background: 'var(--color-danger, #ef4444)' }}>Elimina</Button>
            </>
          }
        >
          <div style={{ textAlign: 'center' }}>
            <Trash2 size={32} color="var(--color-danger, #ef4444)" style={{ marginBottom: 12 }} />
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: 0 }}>Questa azione non puo essere annullata.</p>
          </div>
        </Modal>,
        document.body,
      )}
    </PageContainer>
  )
}
