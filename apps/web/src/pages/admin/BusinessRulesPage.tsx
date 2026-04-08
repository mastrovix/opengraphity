import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { toast } from 'sonner'
import {
  GitBranch, Plus, Trash2, Pencil, GripVertical, ChevronUp, ChevronDown, X,
} from 'lucide-react'
import { GET_BUSINESS_RULES } from '@/graphql/queries'
import {
  CREATE_BUSINESS_RULE, UPDATE_BUSINESS_RULE,
  DELETE_BUSINESS_RULE, REORDER_BUSINESS_RULES,
} from '@/graphql/mutations'
// Queries for teams/users/workflows handled inside ActionParamsEditor
// gql no longer needed here — queries handled by ActionParamsEditor
import { ConditionRowEditor } from '@/components/ConditionRowEditor'
import { ActionParamsEditor } from '@/components/ActionParamsEditor'
import { AutomationPreview } from '@/components/AutomationPreview'
import {
  inputS, selectS, textareaS, labelS, btnPrimary, btnSecondary,
} from '@/pages/settings/shared/designerStyles'
import { createPortal } from 'react-dom'

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
// HTTP methods now handled inside ActionParamsEditor

const EMPTY_CONDITION: Condition = { field: '', operator: 'equals', value: '' }
const EMPTY_ACTION: RuleAction   = { type: 'set_field', params: {} }

const badgeStyle = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10,
  fontSize: 11, fontWeight: 600, background: bg, color: fg,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  try { return json ? JSON.parse(json) : fallback } catch { return fallback }
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

// Preview text now handled by AutomationPreview component

// ── Page ──────────────────────────────────────────────────────────────────────

export function BusinessRulesPage() {
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const handleSort = (f: string, d: 'asc' | 'desc') => { setSortField(f); setSortDir(d) }
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
  const { data, loading, refetch } = useQuery<{ businessRules: BusinessRule[] }>(GET_BUSINESS_RULES, { variables: { sortField, sortDirection: sortDir, filters: filterGroup ? JSON.stringify(filterGroup) : null } })
  const [createRule]  = useMutation(CREATE_BUSINESS_RULE)
  const [updateRule]  = useMutation(UPDATE_BUSINESS_RULE)
  const [deleteRule]  = useMutation(DELETE_BUSINESS_RULE)
  const [reorderRules] = useMutation(REORDER_BUSINESS_RULES)

  const [modalOpen, setModalOpen] = useState(false)
  const [editId,    setEditId]    = useState<string | null>(null)

  // form state
  const [name,           setName]           = useState('')
  const [description,    setDescription]    = useState('')
  const [entityType,     setEntityType]     = useState<string>('incident')
  const [eventType,      setEventType]      = useState<string>('on_create')
  const [conditionLogic, setConditionLogic] = useState<'AND' | 'OR'>('AND')
  const [conditions,     setConditions]     = useState<Condition[]>([{ ...EMPTY_CONDITION }])
  const [actions,        setActions]        = useState<RuleAction[]>([{ ...EMPTY_ACTION }])
  const [priority,       setPriority]       = useState(10)
  const [stopOnMatch,    setStopOnMatch]    = useState(false)
  const [enabled,        setEnabled]        = useState(true)

  const rules: BusinessRule[] = (data?.businessRules ?? [])
    .slice()
    .sort((a: BusinessRule, b: BusinessRule) => a.priority - b.priority)

  // ── Helpers ───────────────────────────────────────────────────────────────

  function resetForm() {
    setName(''); setDescription(''); setEntityType('incident'); setEventType('on_create')
    setConditionLogic('AND'); setConditions([{ ...EMPTY_CONDITION }])
    setActions([{ ...EMPTY_ACTION }]); setPriority(10); setStopOnMatch(false); setEnabled(true)
    setEditId(null)
  }

  function openCreate() { resetForm(); setModalOpen(true) }

  function openEdit(r: BusinessRule) {
    setEditId(r.id); setName(r.name); setDescription(r.description ?? '')
    setEntityType(r.entityType); setEventType(r.eventType)
    setConditionLogic(r.conditionLogic as 'AND' | 'OR')
    setConditions(safeParse(r.conditions, [{ ...EMPTY_CONDITION }]))
    setActions(migrateActions(safeParse(r.actions, [{ ...EMPTY_ACTION }])))
    setPriority(r.priority); setStopOnMatch(r.stopOnMatch); setEnabled(r.enabled)
    setModalOpen(true)
  }

  async function handleSave() {
    if (!name.trim()) { toast.error('Nome obbligatorio'); return }
    try {
      if (editId) {
        await updateRule({ variables: { id: editId, input: {
          name, description: description || null, eventType, conditionLogic,
          conditions: JSON.stringify(conditions), actions: JSON.stringify(actions),
          priority, stopOnMatch, enabled,
        } } })
        toast.success('Regola aggiornata')
      } else {
        await createRule({ variables: { input: {
          name, description: description || null, entityType, eventType, conditionLogic,
          conditions: JSON.stringify(conditions), actions: JSON.stringify(actions),
          priority, stopOnMatch, enabled,
        } } })
        toast.success('Regola creata')
      }
      setModalOpen(false); resetForm(); refetch()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDelete(id: string) {
    if (!confirm('Eliminare questa regola?')) return
    try { await deleteRule({ variables: { id } }); toast.success('Regola eliminata'); refetch() }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  async function handleToggleEnabled(r: BusinessRule) {
    try {
      await updateRule({ variables: { id: r.id, input: { enabled: !r.enabled } } })
      refetch()
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  async function moveRule(idx: number, dir: -1 | 1) {
    const ids = rules.map(r => r.id)
    const target = idx + dir
    if (target < 0 || target >= ids.length) return
    ;[ids[idx], ids[target]] = [ids[target], ids[idx]]
    try { await reorderRules({ variables: { ruleIds: ids } }); refetch() }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  const ruleColumns: ColumnDef<BusinessRule>[] = [
    { key: 'description', label: '', width: '60px', render: (_v, row) => {
      const idx = rules.indexOf(row)
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <GripVertical size={14} style={{ color: '#cbd5e1', cursor: 'grab' }} />
          <button onClick={() => moveRule(idx, -1)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} disabled={idx === 0}><ChevronUp size={14} color={idx === 0 ? '#e5e7eb' : '#64748b'} /></button>
          <button onClick={() => moveRule(idx, 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }} disabled={idx === rules.length - 1}><ChevronDown size={14} color={idx === rules.length - 1 ? '#e5e7eb' : '#64748b'} /></button>
        </div>
      )
    } },
    { key: 'priority', label: '#', sortable: true, render: (v) => <span style={{ fontWeight: 600, color: 'var(--color-brand)' }}>{String(v)}</span> },
    { key: 'name', label: 'Nome', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
    { key: 'entityType', label: 'Entità', sortable: true },
    { key: 'eventType', label: 'Evento', sortable: true, render: (v) => String(v).replace('on_', '') },
    { key: 'conditionLogic', label: 'Logica', render: (v) => <span style={badgeStyle(v === 'AND' ? '#dbeafe' : '#fef3c7', v === 'AND' ? '#1d4ed8' : '#92400e')}>{String(v)}</span> },
    { key: 'stopOnMatch', label: 'Stop', render: (v) => v ? <span style={badgeStyle('#fee2e2', '#dc2626')}>STOP</span> : null },
    { key: 'enabled', label: 'Attiva', render: (_v, row) => (
      <div onClick={() => handleToggleEnabled(row)} style={{ width: 36, height: 20, borderRadius: 10, background: row.enabled ? 'var(--color-brand)' : '#cbd5e1', cursor: 'pointer', position: 'relative', transition: 'background .2s' }}>
        <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: row.enabled ? 18 : 2, transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.15)' }} />
      </div>
    ) },
    { key: 'id', label: 'Azioni', render: (_v, row) => (
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => openEdit(row)} style={{ ...btnSecondary, padding: '4px 8px' }}><Pencil size={13} /></button>
        <button onClick={() => handleDelete(row.id)} style={{ ...btnSecondary, padding: '4px 8px', color: '#ef4444', borderColor: '#fecaca' }}><Trash2 size={13} /></button>
      </div>
    ) },
  ]

  // ── Condition / Action builders ───────────────────────────────────────────

  function updateCondition(i: number, patch: Partial<Condition>) {
    setConditions(prev => prev.map((c, j) => j === i ? { ...c, ...patch } : c))
  }
  function removeCondition(i: number) { setConditions(prev => prev.filter((_, j) => j !== i)) }
  function addCondition() { setConditions(prev => [...prev, { ...EMPTY_CONDITION }]) }

  function setActionParam(i: number, key: string, val: string) {
    setActions(prev => prev.map((a, j) => j === i ? { ...a, params: { ...a.params, [key]: val } } : a))
  }
  function updateAction(i: number, patch: Partial<RuleAction>) {
    setActions(prev => prev.map((a, j) => j === i ? { ...a, ...patch } : a))
  }
  function removeAction(i: number) { setActions(prev => prev.filter((_, j) => j !== i)) }
  function addAction() { setActions(prev => [...prev, { ...EMPTY_ACTION }]) }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<GitBranch size={22} color="var(--color-brand)" />}>Business Rules</PageTitle>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${rules.length} regole`}
          </p>
        </div>
        <button style={btnPrimary} onClick={openCreate}><Plus size={14} /> Nuova regola</button>
      </div>

      <FilterBuilder fields={RULE_FILTER_FIELDS} onApply={g => setFilterGroup(g)} />

      {!loading && !rules.length && (
        <EmptyState
          icon={<GitBranch size={32} color="var(--color-slate-light)" />}
          title="Nessuna regola configurata"
        />
      )}

      {!loading && rules.length > 0 && (
        <SortableFilterTable<BusinessRule>
          columns={ruleColumns}
          onSort={handleSort}
          sortField={sortField}
          sortDir={sortDir}
          data={rules}
          loading={false}
          label="Business Rules"
        />
      )}

      {/* ── Modal ──────────────────────────────────────────────────────────── */}
      {modalOpen && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.35)' }} onClick={() => { setModalOpen(false); resetForm() }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, width: 680, maxHeight: '88vh', overflowY: 'auto', padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.18)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{editId ? 'Modifica regola' : 'Nuova regola'}</h2>
              <button onClick={() => { setModalOpen(false); resetForm() }} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {/* Basic fields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div>
                <label style={labelS}>Nome *</label>
                <input style={inputS} value={name} onChange={e => setName(e.target.value)} placeholder="Assegna priorità alta" />
              </div>
              <div>
                <label style={labelS}>Priorità</label>
                <input style={inputS} type="number" value={priority} onChange={e => setPriority(+e.target.value)} min={1} />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelS}>Descrizione</label>
              <textarea style={textareaS} value={description} onChange={e => setDescription(e.target.value)} rows={2} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div>
                <label style={labelS}>Tipo entità</label>
                <select style={selectS} value={entityType} onChange={e => setEntityType(e.target.value)}>
                  {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelS}>Evento</label>
                <select style={selectS} value={eventType} onChange={e => setEventType(e.target.value)}>
                  {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            {/* Condition Logic toggle */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelS}>Logica condizioni</label>
              <div style={{ display: 'flex', gap: 0 }}>
                {(['AND', 'OR'] as const).map(v => (
                  <button key={v} onClick={() => setConditionLogic(v)} style={{
                    padding: '6px 18px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: '1px solid #e5e7eb', background: conditionLogic === v ? 'var(--color-brand)' : '#fff',
                    color: conditionLogic === v ? '#fff' : 'var(--color-slate)',
                    borderRadius: v === 'AND' ? '6px 0 0 6px' : '0 6px 6px 0',
                  }}>{v}</button>
                ))}
              </div>
            </div>

            {/* Conditions builder */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ ...labelS, marginBottom: 8 }}>Condizioni</label>
              {conditions.map((c, i) => (
                <ConditionRowEditor
                  key={i}
                  condition={c}
                  entityType={entityType}
                  onChange={patch => updateCondition(i, patch)}
                  onRemove={() => removeCondition(i)}
                />
              ))}
              <button onClick={addCondition} style={{ ...btnSecondary, fontSize: 12, padding: '4px 10px', marginTop: 4 }}><Plus size={12} /> Aggiungi condizione</button>
            </div>

            {/* Actions builder */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ ...labelS, marginBottom: 8 }}>Azioni</label>
              {actions.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 8 }}>
                  <select style={{ ...selectS, width: 170 }} value={a.type} onChange={e => updateAction(i, { type: e.target.value, params: {} })}>
                    {ACTION_TYPES.map(t => <option key={t} value={t}>{ACTION_LABELS[t] ?? t}</option>)}
                  </select>
                  <ActionParamsEditor
                    actionType={a.type}
                    params={a.params}
                    entityType={entityType}
                    onChange={(key, val) => setActionParam(i, key, val)}
                  />
                  <button onClick={() => removeAction(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0 }}><Trash2 size={14} color="#ef4444" /></button>
                </div>
              ))}
              <button onClick={addAction} style={{ ...btnSecondary, fontSize: 12, padding: '4px 10px', marginTop: 4 }}><Plus size={12} /> Aggiungi azione</button>
            </div>

            {/* Toggles */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={stopOnMatch} onChange={e => setStopOnMatch(e.target.checked)} /> Stop on match
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Attiva
              </label>
            </div>

            {/* Preview */}
            <AutomationPreview
              entityType={entityType}
              eventType={eventType}
              conditions={conditions}
              conditionLogic={conditionLogic}
              actions={actions}
            />

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button style={btnSecondary} onClick={() => { setModalOpen(false); resetForm() }}>Annulla</button>
              <button style={btnPrimary} onClick={handleSave}>{editId ? 'Salva modifiche' : 'Crea regola'}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </PageContainer>
  )
}
