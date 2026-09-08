import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { toast } from 'sonner'
import {
  GitBranch, Plus, Trash2, Pencil, GripVertical, ChevronUp, ChevronDown,
} from 'lucide-react'
import { GET_BUSINESS_RULES } from '@/graphql/queries'
import {
  CREATE_BUSINESS_RULE, UPDATE_BUSINESS_RULE,
  DELETE_BUSINESS_RULE, REORDER_BUSINESS_RULES,
} from '@/graphql/mutations'
import { ConditionRowEditor } from '@/components/ConditionRowEditor'
import { ActionParamsEditor } from '@/components/ActionParamsEditor'
import { AutomationPreview } from '@/components/AutomationPreview'
import { selectS, labelS } from '@/components/ui/styles'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { Toggle } from '@/components/ui/Toggle'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { useListQueryState } from '@/hooks/useListQueryState'
import { useCrudModal } from '@/hooks/useCrudModal'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Condition { field: string; operator: string; value: string }
interface RuleAction {
  type:   string
  params: Record<string, string>
}
interface BusinessRule {
  id: string; name: string; description: string | null
  entityType: string; eventType: string; conditionLogic: string
  conditions: string; actions: string
  priority: number; stopOnMatch: boolean; enabled: boolean
}

type RuleDraft = {
  name: string; description: string; entityType: string; eventType: string
  conditionLogic: 'AND' | 'OR'; conditions: Condition[]; actions: RuleAction[]
  priority: number; stopOnMatch: boolean; enabled: boolean
}

import { ITIL_ENTITY_TYPES as ENTITY_TYPES } from '@/constants'
const EVENT_TYPES   = ['on_create', 'on_update', 'on_transition'] as const
// Operators now handled by ConditionRowEditor component
const ACTION_TYPES  = ['set_field', 'assign_team', 'assign_user', 'transition_workflow', 'create_notification', 'create_comment', 'set_priority', 'execute_script', 'call_webhook', 'set_sla'] as const
const ACTION_LABELS: Record<string, string> = {
  set_field: 'Imposta campo', assign_team: 'Assegna team', assign_user: 'Assegna utente',
  transition_workflow: 'Transizione workflow', create_notification: 'Crea notifica',
  create_comment: 'Crea commento', set_priority: 'Imposta priorità',
  execute_script: 'Esegui script', call_webhook: 'Chiama webhook', set_sla: 'Imposta SLA',
}

const EMPTY_CONDITION: Condition = { field: '', operator: 'equals', value: '' }
const EMPTY_ACTION: RuleAction   = { type: 'set_field', params: {} }

const emptyDraft = (): RuleDraft => ({
  name: '', description: '', entityType: 'incident', eventType: 'on_create',
  conditionLogic: 'AND', conditions: [{ ...EMPTY_CONDITION }], actions: [{ ...EMPTY_ACTION }],
  priority: 10, stopOnMatch: false, enabled: true,
})

const RULE_FILTER_FIELDS: FieldConfig[] = [
  { key: 'entityType', label: 'Tipo entità', type: 'enum', options: [
    { value: 'incident', label: 'Incident' }, { value: 'change', label: 'Change' },
    { value: 'problem', label: 'Problem' }, { value: 'service_request', label: 'Service Request' },
  ]},
  { key: 'eventType', label: 'Tipo evento', type: 'enum', options: [
    { value: 'on_create', label: 'Creazione' }, { value: 'on_update', label: 'Aggiornamento' },
    { value: 'on_transition', label: 'Transizione' },
  ]},
  { key: 'enabled', label: 'Abilitato', type: 'enum', options: [
    { value: 'true', label: 'Sì' }, { value: 'false', label: 'No' },
  ]},
  { key: 'conditionLogic', label: 'Logica', type: 'enum', options: [
    { value: 'and', label: 'AND' }, { value: 'or', label: 'OR' },
  ]},
  { key: 'name', label: 'Nome', type: 'text' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses stored rule JSON. Missing → fallback; CORRUPT → throws.
 * Opening the editor with silently-emptied conditions/actions would let a
 * save overwrite (destroy) the original data without the user ever knowing.
 */
function parseStored<T>(json: string | null | undefined, fallback: T, what: string): T {
  if (!json) return fallback
  try { return JSON.parse(json) as T }
  catch (e) {
    throw new Error(`JSON corrotto in "${what}": ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Migrates old flat action format { type, value, field, ... } to { type, params } */
function migrateActions(raw: unknown[]): RuleAction[] {
  return raw.map(a => {
    const obj = a as Record<string, unknown>
    if (obj['params'] && typeof obj['params'] === 'object') return obj as unknown as RuleAction
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k !== 'type' && v != null) params[k] = String(v)
    }
    return { type: String(obj['type'] ?? 'set_field'), params }
  })
}

/** Refuses corrupt data (throws): see parseStored. */
function ruleToDraft(r: BusinessRule): RuleDraft {
  return {
    name: r.name, description: r.description ?? '',
    entityType: r.entityType, eventType: r.eventType,
    conditionLogic: r.conditionLogic as 'AND' | 'OR',
    conditions: parseStored(r.conditions, [{ ...EMPTY_CONDITION }], 'conditions'),
    actions:    migrateActions(parseStored(r.actions, [{ ...EMPTY_ACTION }], 'actions')),
    priority: r.priority, stopOnMatch: r.stopOnMatch, enabled: r.enabled,
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function BusinessRulesPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const list  = useListQueryState()
  const modal = useCrudModal<BusinessRule, RuleDraft>(emptyDraft, ruleToDraft)
  const { draft, patch } = modal

  const { data, loading, refetch } = useQuery<{ businessRules: BusinessRule[] }>(GET_BUSINESS_RULES, { variables: list.variables })
  const [createRule]  = useMutation(CREATE_BUSINESS_RULE)
  const [updateRule]  = useMutation(UPDATE_BUSINESS_RULE)
  const [deleteRule]  = useMutation(DELETE_BUSINESS_RULE)
  const [reorderRules] = useMutation(REORDER_BUSINESS_RULES)

  const rules: BusinessRule[] = (data?.businessRules ?? [])
    .slice()
    .sort((a: BusinessRule, b: BusinessRule) => a.priority - b.priority)

  // ── Helpers ───────────────────────────────────────────────────────────────

  function openEdit(r: BusinessRule) {
    // Refuse to open the editor on corrupt data: an editor silently opened
    // empty would destroy the original conditions/actions at the next save.
    try { modal.openEdit(r) }
    catch (e) { toast.error(`Impossibile aprire "${r.name}": ${errorMessage(e)}. Correggi il dato dal database prima di modificare.`) }
  }

  async function handleSave() {
    if (!draft.name.trim()) { toast.error('Nome obbligatorio'); return }
    const common = {
      name: draft.name, description: draft.description || null, eventType: draft.eventType, conditionLogic: draft.conditionLogic,
      conditions: JSON.stringify(draft.conditions), actions: JSON.stringify(draft.actions),
      priority: draft.priority, stopOnMatch: draft.stopOnMatch, enabled: draft.enabled,
    }
    try {
      if (modal.editing) {
        await updateRule({ variables: { id: modal.editing.id, input: common } })
        toast.success('Regola aggiornata')
      } else {
        await createRule({ variables: { input: { ...common, entityType: draft.entityType } } })
        toast.success('Regola creata')
      }
      modal.close(); void refetch()
    } catch (e: unknown) { toast.error(errorMessage(e)) }
  }

  async function handleDelete(r: BusinessRule) {
    const ok = await confirm({ title: t('admin.rules.deleteTitle'), body: r.name, danger: true })
    if (!ok) return
    try { await deleteRule({ variables: { id: r.id } }); toast.success('Regola eliminata'); void refetch() }
    catch (e: unknown) { toast.error(errorMessage(e)) }
  }

  async function handleToggleEnabled(r: BusinessRule) {
    try {
      await updateRule({ variables: { id: r.id, input: { enabled: !r.enabled } } })
      void refetch()
    } catch (e: unknown) { toast.error(errorMessage(e)) }
  }

  async function moveRule(idx: number, dir: -1 | 1) {
    const ids = rules.map(r => r.id)
    const target = idx + dir
    if (target < 0 || target >= ids.length) return
    ;[ids[idx], ids[target]] = [ids[target], ids[idx]]
    try { await reorderRules({ variables: { ruleIds: ids } }); void refetch() }
    catch (e: unknown) { toast.error(errorMessage(e)) }
  }

  const ruleColumns: ColumnDef<BusinessRule>[] = [
    { key: 'description', label: '', width: '60px', render: (_v, row) => {
      const idx = rules.indexOf(row)
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <GripVertical size={14} aria-hidden="true" style={{ color: 'var(--border-strong)', cursor: 'grab' }} />
          <Button variant="ghost" title={t('admin.rules.moveUp')} aria-label={t('admin.rules.moveUp')} onClick={() => void moveRule(idx, -1)} disabled={idx === 0} style={{ padding: 2 }}><ChevronUp size={14} aria-hidden="true" color={idx === 0 ? 'var(--border)' : 'var(--color-slate)'} /></Button>
          <Button variant="ghost" title={t('admin.rules.moveDown')} aria-label={t('admin.rules.moveDown')} onClick={() => void moveRule(idx, 1)} disabled={idx === rules.length - 1} style={{ padding: 2 }}><ChevronDown size={14} aria-hidden="true" color={idx === rules.length - 1 ? 'var(--border)' : 'var(--color-slate)'} /></Button>
        </div>
      )
    } },
    { key: 'priority', label: '#', sortable: true, render: (v) => <span style={{ fontWeight: 600, color: 'var(--color-brand)' }}>{String(v)}</span> },
    { key: 'name', label: 'Nome', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
    { key: 'entityType', label: 'Entità', sortable: true },
    { key: 'eventType', label: 'Evento', sortable: true, render: (v) => String(v).replace('on_', '') },
    { key: 'conditionLogic', label: 'Logica', sortable: true, render: (v) => <Pill bg={v === 'AND' ? '#dbeafe' : '#fef3c7'} color={v === 'AND' ? '#1d4ed8' : '#92400e'} radius={10}>{String(v)}</Pill> },
    { key: 'stopOnMatch', label: 'Stop', sortable: true, render: (v) => v ? <Pill bg="#fee2e2" color="var(--color-trigger-sla-breach)" radius={10}>STOP</Pill> : null },
    { key: 'enabled', label: 'Attiva', sortable: true, render: (_v, row) => (
      <Toggle checked={row.enabled} onChange={() => void handleToggleEnabled(row)} label={t('admin.rules.toggleLabel', { name: row.name })} />
    ) },
    { key: 'id', label: 'Azioni', sortable: true, render: (_v, row) => (
      <div style={{ display: 'flex', gap: 6 }}>
        <Button variant="icon" size="xs" title={t('common.edit')} onClick={() => openEdit(row)}><Pencil size={13} aria-hidden="true" /></Button>
        <Button variant="icon" size="xs" title={t('common.delete')} onClick={() => void handleDelete(row)} style={{ color: 'var(--color-danger)', borderColor: '#fecaca' }}><Trash2 size={13} aria-hidden="true" /></Button>
      </div>
    ) },
  ]

  // ── Condition / Action builders ───────────────────────────────────────────

  const updateCondition = (i: number, p: Partial<Condition>) => patch({ conditions: draft.conditions.map((c, j) => j === i ? { ...c, ...p } : c) })
  const removeCondition = (i: number) => patch({ conditions: draft.conditions.filter((_, j) => j !== i) })
  const addCondition = () => patch({ conditions: [...draft.conditions, { ...EMPTY_CONDITION }] })

  const setActionParam = (i: number, key: string, val: string) => patch({ actions: draft.actions.map((a, j) => j === i ? { ...a, params: { ...a.params, [key]: val } } : a) })
  const updateAction = (i: number, p: Partial<RuleAction>) => patch({ actions: draft.actions.map((a, j) => j === i ? { ...a, ...p } : a) })
  const removeAction = (i: number) => patch({ actions: draft.actions.filter((_, j) => j !== i) })
  const addAction = () => patch({ actions: [...draft.actions, { ...EMPTY_ACTION }] })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<GitBranch size={22} color="var(--color-icon-accent)" />}>Business Rules</PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${rules.length} regole`}
          </p>
        </div>
        <Button icon={<Plus size={14} aria-hidden="true" />} onClick={modal.openCreate}>Nuova regola</Button>
      </div>

      <FilterBuilder fields={RULE_FILTER_FIELDS} onApply={list.setFilterGroup} />

      {!loading && !rules.length && (
        <EmptyState
          icon={<GitBranch size={32} color="var(--color-slate-light)" />}
          title="Nessuna regola configurata"
        />
      )}

      {!loading && rules.length > 0 && (
        <SortableFilterTable<BusinessRule>
          columns={ruleColumns}
          onSort={list.handleSort}
          sortField={list.sortField}
          sortDir={list.sortDir}
          data={rules}
          loading={false}
          label="Business Rules"
        />
      )}

      {/* ── Modal ──────────────────────────────────────────────────────────── */}
      <Modal
        open={modal.open}
        onClose={modal.close}
        title={modal.editing ? 'Modifica regola' : 'Nuova regola'}
        width={680}
        zIndex={9000}
        closeOnOverlay={false}
        footerStyle={{ gap: 10 }}
        footer={
          <>
            <Button variant="secondary" size="xs" onClick={modal.close}>{t('common.cancel')}</Button>
            <Button onClick={() => void handleSave()}>{modal.editing ? 'Salva modifiche' : 'Crea regola'}</Button>
          </>
        }
      >
          {/* Basic fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
            <div>
              <label style={labelS}>Nome *</label>
              <Input value={draft.name} onChange={e => patch({ name: e.target.value })} placeholder="Assegna priorità alta" />
            </div>
            <div>
              <label style={labelS}>Priorità</label>
              <Input type="number" value={draft.priority} onChange={e => patch({ priority: +e.target.value })} min={1} />
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelS}>Descrizione</label>
            <Textarea value={draft.description} onChange={e => patch({ description: e.target.value })} rows={2} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
            <div>
              <label style={labelS}>Tipo entità</label>
              <Select style={selectS} value={draft.entityType} onChange={e => patch({ entityType: e.target.value })} disabled={modal.isEditing}>
                {ENTITY_TYPES.map(et => <option key={et} value={et}>{et}</option>)}
              </Select>
            </div>
            <div>
              <label style={labelS}>Evento</label>
              <Select style={selectS} value={draft.eventType} onChange={e => patch({ eventType: e.target.value })}>
                {EVENT_TYPES.map(et => <option key={et} value={et}>{et}</option>)}
              </Select>
            </div>
          </div>

          {/* Condition Logic toggle */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelS}>Logica condizioni</label>
            <div role="group" aria-label="Logica condizioni" style={{ display: 'flex', gap: 0 }}>
              {(['AND', 'OR'] as const).map(v => (
                <button key={v} type="button" aria-pressed={draft.conditionLogic === v} onClick={() => patch({ conditionLogic: v })} style={{
                  padding: '6px 18px', fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer',
                  border: '1px solid var(--border)', background: draft.conditionLogic === v ? 'var(--color-brand)' : '#fff',
                  color: draft.conditionLogic === v ? '#fff' : 'var(--color-slate)',
                  borderRadius: v === 'AND' ? '6px 0 0 6px' : '0 6px 6px 0',
                }}>{v}</button>
              ))}
            </div>
          </div>

          {/* Conditions builder */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ ...labelS, marginBottom: 8 }}>Condizioni</label>
            {draft.conditions.map((c, i) => (
              <ConditionRowEditor
                key={i}
                condition={c}
                entityType={draft.entityType}
                onChange={p => updateCondition(i, p)}
                onRemove={() => removeCondition(i)}
              />
            ))}
            <Button variant="secondary" size="xs" icon={<Plus size={12} aria-hidden="true" />} onClick={addCondition} style={{ marginTop: 4 }}>Aggiungi condizione</Button>
          </div>

          {/* Actions builder */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ ...labelS, marginBottom: 8 }}>Azioni</label>
            {draft.actions.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 8 }}>
                <Select style={{ ...selectS, width: 170 }} value={a.type} onChange={e => updateAction(i, { type: e.target.value, params: {} })}>
                  {ACTION_TYPES.map(at => <option key={at} value={at}>{ACTION_LABELS[at] ?? at}</option>)}
                </Select>
                <ActionParamsEditor
                  actionType={a.type}
                  params={a.params}
                  entityType={draft.entityType}
                  onChange={(key, val) => setActionParam(i, key, val)}
                />
                <Button variant="ghost" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => removeAction(i)} style={{ padding: 4, flexShrink: 0, color: 'var(--color-danger)' }}><Trash2 size={14} aria-hidden="true" /></Button>
              </div>
            ))}
            <Button variant="secondary" size="xs" icon={<Plus size={12} aria-hidden="true" />} onClick={addAction} style={{ marginTop: 4 }}>Aggiungi azione</Button>
          </div>

          {/* Toggles */}
          <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
              <input type="checkbox" checked={draft.stopOnMatch} onChange={e => patch({ stopOnMatch: e.target.checked })} /> Stop on match
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
              <input type="checkbox" checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })} /> Attiva
            </label>
          </div>

          {/* Preview */}
          <AutomationPreview
            entityType={draft.entityType}
            eventType={draft.eventType}
            conditions={draft.conditions}
            conditionLogic={draft.conditionLogic}
            actions={draft.actions}
          />
      </Modal>
    </PageContainer>
  )
}
