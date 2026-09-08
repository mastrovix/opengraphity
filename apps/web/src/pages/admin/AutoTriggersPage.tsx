import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { Zap, Plus, Pencil, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { GET_AUTO_TRIGGERS } from '@/graphql/queries'
import { CREATE_AUTO_TRIGGER, UPDATE_AUTO_TRIGGER, DELETE_AUTO_TRIGGER } from '@/graphql/mutations'
import { selectS, labelS } from '@/components/ui/styles'
import { Input, Select } from '@/components/ui/FormControls'
import { Toggle } from '@/components/ui/Toggle'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { ActionParamsEditor } from '@/components/ActionParamsEditor'
import { ConditionRowEditor } from '@/components/ConditionRowEditor'
import { AutomationPreview } from '@/components/AutomationPreview'
import { useListQueryState } from '@/hooks/useListQueryState'
import { useCrudModal } from '@/hooks/useCrudModal'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { formatDateTime } from '@/lib/datetime'

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses stored trigger JSON. Missing → fallback; CORRUPT → throws.
 * Opening the editor with silently-emptied conditions/actions would let a
 * save overwrite (destroy) the original data without the user ever knowing.
 */
function parseJSON<T>(s: string | null | undefined, fallback: T, what: string): T {
  if (!s) return fallback
  try { return JSON.parse(s) as T }
  catch (e) {
    throw new Error(`JSON corrotto in "${what}": ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Refuses corrupt data (throws): see parseJSON. */
function triggerToForm(t: AutoTrigger): FormData {
  return {
    name: t.name, entityType: t.entityType, eventType: t.eventType,
    timerDelayMinutes: t.timerDelayMinutes ?? 0,
    conditions: parseJSON<Condition[]>(t.conditions, [], 'conditions'),
    actions:    parseJSON<TriggerAction[]>(t.actions, [], 'actions'),
    enabled: t.enabled,
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function AutoTriggersPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const list  = useListQueryState()
  const modal = useCrudModal<AutoTrigger, FormData>(emptyForm, triggerToForm)
  const { draft: form, patch } = modal

  const { data, loading, refetch } = useQuery<{ autoTriggers: AutoTrigger[] }>(GET_AUTO_TRIGGERS, {
    variables: list.variables,
  })
  const triggers: AutoTrigger[] = data?.autoTriggers ?? []

  const [createTrigger] = useMutation(CREATE_AUTO_TRIGGER, { onCompleted: () => { toast.success('Trigger creato'); void refetch(); modal.close() }, onError: (e) => toast.error(e.message) })
  const [updateTrigger] = useMutation(UPDATE_AUTO_TRIGGER, { onCompleted: () => { toast.success('Trigger aggiornato'); void refetch(); modal.close() }, onError: (e) => toast.error(e.message) })
  const [deleteTrigger] = useMutation(DELETE_AUTO_TRIGGER, { onCompleted: () => { toast.success('Trigger eliminato'); void refetch() }, onError: (e) => toast.error(e.message) })

  function openEdit(trigger: AutoTrigger) {
    // Refuse to open the editor on corrupt data: an editor silently opened
    // empty would destroy the original conditions/actions at the next save.
    try { modal.openEdit(trigger) }
    catch (e) { toast.error(`Impossibile aprire "${trigger.name}": ${errorMessage(e)}. Correggi il dato dal database prima di modificare.`) }
  }

  function handleSave() {
    if (!form.name.trim()) { toast.error('Nome obbligatorio'); return }
    const common = {
      name: form.name, eventType: form.eventType,
      timerDelayMinutes: form.eventType === 'on_timer' ? form.timerDelayMinutes : null,
      conditions: JSON.stringify(form.conditions),
      actions: JSON.stringify(form.actions),
      enabled: form.enabled,
    }
    if (modal.editing) {
      void updateTrigger({ variables: { id: modal.editing.id, input: common } })
    } else {
      void createTrigger({ variables: { input: { ...common, entityType: form.entityType } } })
    }
  }

  async function handleDelete(trigger: AutoTrigger) {
    const ok = await confirm({ title: t('admin.triggers.deleteTitle'), body: trigger.name, danger: true })
    if (ok) void deleteTrigger({ variables: { id: trigger.id } })
  }

  function handleToggleEnabled(trigger: AutoTrigger) {
    void updateTrigger({ variables: { id: trigger.id, input: { enabled: !trigger.enabled } } })
  }

  // ── Condition helpers ──────────────────────────────────────────────────────
  const addCondition = () => patch({ conditions: [...form.conditions, { field: '', operator: 'equals', value: '' }] })
  const removeCondition = (i: number) => patch({ conditions: form.conditions.filter((_, idx) => idx !== i) })
  const setCondition = (i: number, p: Partial<Condition>) => patch({ conditions: form.conditions.map((c, idx) => idx === i ? { ...c, ...p } : c) })

  // ── Action helpers ─────────────────────────────────────────────────────────
  const addAction = () => patch({ actions: [...form.actions, { type: 'set_field', params: {} }] })
  const removeAction = (i: number) => patch({ actions: form.actions.filter((_, idx) => idx !== i) })
  const setAction = (i: number, p: Partial<TriggerAction>) => patch({ actions: form.actions.map((a, idx) => idx === i ? { ...a, ...p } : a) })
  const setActionParam = (i: number, key: string, val: string) =>
    patch({ actions: form.actions.map((a, idx) => idx === i ? { ...a, params: { ...a.params, [key]: val } } : a) })

  const triggerColumns: ColumnDef<AutoTrigger>[] = [
    { key: 'name', label: 'Nome', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
    { key: 'entityType', label: 'Entità', sortable: true },
    { key: 'eventType', label: 'Evento', sortable: true, render: (v) => EVENT_LABELS[String(v)] || String(v) },
    { key: 'enabled', label: 'Abilitato', sortable: true, render: (_v, row) => (
      <Toggle checked={row.enabled} onChange={() => handleToggleEnabled(row)} label={t('admin.triggers.toggleLabel', { name: row.name })} />
    ) },
    { key: 'executionCount', label: 'Esecuzioni', sortable: true },
    { key: 'lastExecutedAt', label: 'Ultima esecuzione', sortable: true, render: (v) => v ? formatDateTime(String(v)) : '—' },
    { key: 'id', label: 'Azioni', sortable: true, render: (_v, row) => (
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <Button variant="icon" size="xs" title={t('common.edit')} onClick={() => openEdit(row)}><Pencil size={14} aria-hidden="true" /></Button>
        <Button variant="icon" size="xs" title={t('common.delete')} onClick={() => void handleDelete(row)} style={{ color: 'var(--color-danger)', borderColor: '#fecaca' }}><Trash2 size={14} aria-hidden="true" /></Button>
      </div>
    ) },
  ]

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
        <Button icon={<Plus size={15} aria-hidden="true" />} onClick={modal.openCreate}>Nuovo Trigger</Button>
      </div>

      <FilterBuilder fields={TRIGGER_FILTER_FIELDS} onApply={list.setFilterGroup} />

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
          onSort={list.handleSort}
          sortField={list.sortField}
          sortDir={list.sortDir}
          loading={false}
          label="Auto Triggers"
        />
      )}

      {/* ── Create / Edit Modal ─────────────────────────────────────────────── */}
      <Modal
        open={modal.open}
        onClose={modal.close}
        title={modal.editing ? 'Modifica Trigger' : 'Nuovo Trigger'}
        width={680}
        zIndex={9000}
        closeOnOverlay={false}
        footer={
          <>
            <Button variant="secondary" size="xs" onClick={modal.close}>{t('common.cancel')}</Button>
            <Button onClick={handleSave}>{modal.editing ? 'Salva modifiche' : 'Crea trigger'}</Button>
          </>
        }
      >
          {/* Name */}
          <label style={labelS}>Nome</label>
          <Input value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="es. Auto-assign P1 incidents" />

          {/* Entity + Event */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
            <div>
              <label style={labelS}>Tipo entità</label>
              <Select style={selectS} value={form.entityType} onChange={e => patch({ entityType: e.target.value })} disabled={modal.isEditing}>
                {ENTITY_TYPES.map(et => <option key={et} value={et}>{et}</option>)}
              </Select>
            </div>
            <div>
              <label style={labelS}>Tipo evento</label>
              <Select style={selectS} value={form.eventType} onChange={e => patch({ eventType: e.target.value })}>
                {EVENT_TYPES.map(et => <option key={et} value={et}>{EVENT_LABELS[et] || et}</option>)}
              </Select>
            </div>
          </div>

          {/* Timer delay */}
          {form.eventType === 'on_timer' && (
            <div style={{ marginTop: 14 }}>
              <label style={labelS}>Ritardo timer (minuti)</label>
              <Input style={{ width: 120 }} type="number" min={0} value={form.timerDelayMinutes} onChange={e => patch({ timerDelayMinutes: Number(e.target.value) })} />
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
                onChange={p => setCondition(i, p)}
                onRemove={() => removeCondition(i)}
              />
            ))}
            <Button variant="secondary" size="xs" icon={<Plus size={12} aria-hidden="true" />} onClick={addCondition} style={{ marginTop: 4 }}>Aggiungi condizione</Button>
          </div>

          {/* Actions */}
          <div style={{ marginTop: 20 }}>
            <label style={{ ...labelS, fontSize: 'var(--font-size-body)', fontWeight: 600 }}>Azioni</label>
            {form.actions.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                <Select style={{ ...selectS, width: 180 }} value={a.type} onChange={e => setAction(i, { type: e.target.value, params: {} })}>
                  {ACTION_TYPES.map(at => <option key={at} value={at}>{ACTION_LABELS[at]}</option>)}
                </Select>
                <ActionParamsEditor
                  actionType={a.type}
                  params={a.params as Record<string, string>}
                  entityType={form.entityType}
                  onChange={(key, val) => setActionParam(i, key, val)}
                />
                <Button variant="ghost" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => removeAction(i)} style={{ color: 'var(--color-danger)', padding: 2 }}><X size={14} aria-hidden="true" /></Button>
              </div>
            ))}
            <Button variant="secondary" size="xs" icon={<Plus size={12} aria-hidden="true" />} onClick={addAction} style={{ marginTop: 4 }}>Aggiungi azione</Button>
          </div>

          {/* Enabled toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
            <label style={{ ...labelS, margin: 0 }}>Abilitato</label>
            <Toggle checked={form.enabled} onChange={v => patch({ enabled: v })} label={t('admin.triggers.enabledLabel')} />
          </div>

          {/* Preview */}
          <AutomationPreview
            entityType={form.entityType}
            eventType={form.eventType}
            conditions={form.conditions}
            actions={form.actions}
            timerMinutes={form.eventType === 'on_timer' ? form.timerDelayMinutes : null}
          />
      </Modal>
    </PageContainer>
  )
}
