import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useEnumValues } from '@/hooks/useEnumValues'
import { createPortal } from 'react-dom'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import { Shield, Plus, Pencil, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'
import { toast } from 'sonner'
import { GET_SLA_POLICIES, GET_TEAMS } from '@/graphql/queries'
import { CREATE_SLA_POLICY, UPDATE_SLA_POLICY, DELETE_SLA_POLICY } from '@/graphql/mutations'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Select } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SLAPolicy {
  id: string; name: string; entityType: string; priority: string | null
  category: string | null; teamId: string | null; teamName: string | null
  timezone: string; responseMinutes: number; resolveMinutes: number
  businessHours: boolean; enabled: boolean
}

interface Team { id: string; name: string }

type FormState = {
  name: string; entityType: string; priority: string; category: string
  teamId: string; responseMinutes: number; resolveMinutes: number
  businessHours: boolean; timezone: string
}

const EMPTY_FORM: FormState = {
  name: '', entityType: 'incident', priority: '', category: '',
  teamId: '', responseMinutes: 60, resolveMinutes: 480,
  businessHours: true, timezone: 'Europe/Rome',
}

import { ITIL_ENTITY_TYPES as ENTITY_TYPES } from '@/constants'
import { lookupOrError } from '@/lib/tokens'

const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'Service Request',
}

// ── Styles ────────────────────────────────────────────────────────────────────

// Per-page overrides on top of the shared FormControls base style.
const inputS: React.CSSProperties = {
  padding: '7px 10px', border: '1px solid #e5e7eb', color: 'var(--color-slate-dark)',
}
const selectS: React.CSSProperties = {
  ...inputS, appearance: 'none' as const,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}
const labelS: React.CSSProperties = { display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4 }
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: '#fff', fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms',
}
// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMinutes(m: number): string {
  if (m < 60) return `${m}min`
  if (m < 1440) return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}min`
  const d = m / 1440
  return d === Math.floor(d) ? `${d}gg` : `${Math.floor(d)}gg ${fmtMinutes(m % 1440)}`
}

function applicabilityText(p: SLAPolicy): string {
  const parts: string[] = [`${lookupOrError(ENTITY_LABELS, p.entityType, 'ENTITY_LABELS', p.entityType)}`]
  if (p.priority) parts.push(`priorita ${p.priority}`)
  if (p.category) parts.push(`categoria ${p.category}`)
  if (p.teamName) parts.push(`team ${p.teamName}`)
  return parts.length === 1 ? `Si applica a: tutti gli ${parts[0]}` : `Si applica a: ${parts[0]} con ${parts.slice(1).join(', ')}`
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SLAPoliciesPage() {
  const { values: PRIORITIES } = useEnumValues('incident', 'priority')
  const { values: CATEGORIES } = useEnumValues('incident', 'category')
  const [modalOpen, setModalOpen]     = useState(false)
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [deleteId, setDeleteId]       = useState<string | null>(null)
  const [form, setForm]               = useState<FormState>(EMPTY_FORM)

  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const handleSort = (f: string, d: 'asc' | 'desc') => { setSortField(f); setSortDir(d) }
  const SLA_FILTER_FIELDS: FieldConfig[] = [
    { key: 'entityType', label: 'Tipo entità', type: 'enum', options: [
      { value: 'incident', label: 'Incident' }, { value: 'change', label: 'Change' },
      { value: 'problem', label: 'Problem' }, { value: 'service_request', label: 'Service Request' },
    ]},
    { key: 'priority', label: 'Priorità', type: 'enum', options: [
      { value: 'critical', label: 'Critical' }, { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' },
    ]},
    { key: 'category', label: 'Categoria', type: 'enum', options: [
      { value: 'hardware', label: 'Hardware' }, { value: 'software', label: 'Software' },
      { value: 'network', label: 'Network' }, { value: 'access', label: 'Access' },
      { value: 'security', label: 'Security' }, { value: 'other', label: 'Other' },
    ]},
    { key: 'enabled', label: 'Abilitata', type: 'enum', options: [
      { value: 'true', label: 'Sì' }, { value: 'false', label: 'No' },
    ]},
    { key: 'name', label: 'Nome', type: 'text' },
  ]
  const { data, loading } = useQuery<{ slaPolicies: SLAPolicy[] }>(GET_SLA_POLICIES, { variables: { sortField, sortDirection: sortDir, filters: filterGroup ? JSON.stringify(filterGroup) : null } })
  const { data: teamsData }           = useQuery<{ teams: Team[] }>(GET_TEAMS)
  const policies: SLAPolicy[]        = data?.slaPolicies ?? []
  const teams: Team[]                 = teamsData?.teams ?? []

  const refetch = { refetchQueries: [{ query: GET_SLA_POLICIES }] }
  const [createPolicy] = useMutation(CREATE_SLA_POLICY, refetch)
  const [updatePolicy] = useMutation(UPDATE_SLA_POLICY, refetch)
  const [deletePolicy] = useMutation(DELETE_SLA_POLICY, refetch)

  // Group by entity type
  const grouped = ENTITY_TYPES.reduce<Record<string, SLAPolicy[]>>((acc, et) => {
    const items = policies.filter(p => p.entityType === et)
    if (items.length) acc[et] = items
    return acc
  }, {})

  function openCreate() {
    setEditingId(null); setForm(EMPTY_FORM); setModalOpen(true)
  }
  function openEdit(p: SLAPolicy) {
    setEditingId(p.id)
    setForm({
      name: p.name, entityType: p.entityType, priority: p.priority ?? '',
      category: p.category ?? '', teamId: p.teamId ?? '',
      responseMinutes: p.responseMinutes, resolveMinutes: p.resolveMinutes,
      businessHours: p.businessHours, timezone: p.timezone,
    })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error('Il nome e obbligatorio'); return }
    try {
      if (editingId) {
        await updatePolicy({ variables: { id: editingId, input: {
          name: form.name.trim(),
          priority: form.priority || null, category: form.category || null,
          teamId: form.teamId || null,
          responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
          businessHours: form.businessHours, timezone: form.timezone,
        } } })
        toast.success('Policy aggiornata')
      } else {
        await createPolicy({ variables: { input: {
          name: form.name.trim(), entityType: form.entityType,
          priority: form.priority || null, category: form.category || null,
          teamId: form.teamId || null,
          responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
          businessHours: form.businessHours, timezone: form.timezone,
        } } })
        toast.success('Policy creata')
      }
      setModalOpen(false)
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deletePolicy({ variables: { id: deleteId } })
      toast.success('Policy eliminata')
    } catch (e: unknown) { toast.error((e as Error).message) }
    setDeleteId(null)
  }

  async function handleToggle(p: SLAPolicy) {
    try {
      await updatePolicy({ variables: { id: p.id, input: { enabled: !p.enabled } } })
      toast.success(p.enabled ? 'Policy disabilitata' : 'Policy abilitata')
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const policyColumns: ColumnDef<SLAPolicy>[] = [
    { key: 'name', label: 'Nome', sortable: true, render: (_v, row) => (
      <div>
        <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{row.name}</div>
        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)', marginTop: 2, fontStyle: 'italic' }}>{applicabilityText(row)}</div>
      </div>
    ) },
    { key: 'priority', label: 'Priorita', sortable: true, render: (v) => v ? <Pill bg="#fef3c7" color="#92400e" radius={10}>{String(v)}</Pill> : <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>Tutte</span> },
    { key: 'category', label: 'Categoria', sortable: true, render: (v) => v ? <Pill bg="#dbeafe" color="#1e40af" radius={10}>{String(v)}</Pill> : <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>Tutte</span> },
    { key: 'teamName', label: 'Team', sortable: true, render: (v) => <span style={{ color: v ? 'var(--color-slate-dark)' : 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{v ? String(v) : 'Tutti'}</span> },
    { key: 'responseMinutes', label: 'Risposta', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v))}</span> },
    { key: 'resolveMinutes', label: 'Risoluzione', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v))}</span> },
    { key: 'businessHours', label: 'Business Hours', sortable: true, render: (v) => <Pill bg={v ? '#dcfce7' : 'var(--color-border-light)'} color={v ? '#15803d' : 'var(--color-slate)'} radius={10}>{v ? 'Si' : 'No'}</Pill> },
    { key: 'enabled', label: 'Attiva', sortable: true, render: (_v, row) => (
      <button onClick={() => handleToggle(row)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
        {row.enabled ? <ToggleRight size={22} color="var(--color-icon-accent)" /> : <ToggleLeft size={22} color="#cbd5e1" />}
      </button>
    ) },
    { key: 'id', label: 'Azioni', sortable: true, render: (_v, row) => (
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button onClick={() => openEdit(row)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title="Modifica"><Pencil size={15} color="var(--color-slate)" /></button>
        <button onClick={() => setDeleteId(row.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title="Elimina"><Trash2 size={15} color="#ef4444" /></button>
      </div>
    ) },
  ]

  // ── Preview text for modal form ───────────────────────────────────────────
  function formPreview(): string {
    const parts: string[] = [lookupOrError(ENTITY_LABELS, form.entityType, 'ENTITY_LABELS', form.entityType)]
    if (form.priority) parts.push(`priorita ${form.priority}`)
    if (form.category) parts.push(`categoria ${form.category}`)
    const team = teams.find(t => t.id === form.teamId)
    if (team) parts.push(`team ${team.name}`)
    return parts.length === 1 ? `Tutti gli ${parts[0]}` : `${parts[0]} con ${parts.slice(1).join(', ')}`
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Shield size={22} color="var(--color-icon-accent)" />}>SLA Policies</PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${policies.length} policy`}
          </p>
        </div>
        <button style={btnPrimary} onClick={openCreate}><Plus size={15} /> Nuova Policy</button>
      </div>

      {!loading && policies.length === 0 && (
        <EmptyState
          icon={<Shield size={32} color="var(--color-slate-light)" />}
          title="Nessuna SLA policy configurata"
          description="Crea la prima policy per definire i tempi di risposta e risoluzione."
        />
      )}

      <FilterBuilder fields={SLA_FILTER_FIELDS} onApply={g => setFilterGroup(g)} />

      {Object.entries(grouped).map(([entityType, items]) => (
        <div key={entityType} style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 8, textTransform: 'capitalize' }}>
            {ENTITY_LABELS[entityType]}
          </h3>
          <SortableFilterTable<SLAPolicy>
            onSort={handleSort}
            sortField={sortField}
            sortDir={sortDir}
            columns={policyColumns}
            data={items}
            loading={false}
            label={`SLA Policies — ${ENTITY_LABELS[entityType]}`}
          />
        </div>
      ))}

      {/* ── Create / Edit Modal ──────────────────────────────────────────────── */}
      {modalOpen && createPortal(
        <Modal
          open
          onClose={() => setModalOpen(false)}
          title={editingId ? 'Modifica Policy' : 'Nuova SLA Policy'}
          width={560}
          zIndex={9999}
          footer={
            <>
              <Button variant="secondary" onClick={() => setModalOpen(false)} style={{ padding: '7px 14px' }}>Annulla</Button>
              <Button onClick={() => void handleSave()}>{editingId ? 'Salva' : 'Crea'}</Button>
            </>
          }
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelS}>Nome *</label>
                <Input style={inputS} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="es. SLA Critical Incident" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>Tipo Entita *</label>
                  <Select style={selectS} value={form.entityType} onChange={e => setForm({ ...form, entityType: e.target.value })}>
                    {ENTITY_TYPES.map(et => <option key={et} value={et}>{ENTITY_LABELS[et]}</option>)}
                  </Select>
                </div>
                <div>
                  <label style={labelS}>Priorita</label>
                  <Select style={selectS} value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                    <option value="">Tutte</option>
                    {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                  </Select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>Categoria</label>
                  <Select style={selectS} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                    <option value="">Tutte</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </div>
                <div>
                  <label style={labelS}>Team</label>
                  <Select style={selectS} value={form.teamId} onChange={e => setForm({ ...form, teamId: e.target.value })}>
                    <option value="">Tutti</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>Tempo Risposta (minuti) *</label>
                  <Input style={inputS} type="number" min={1} value={form.responseMinutes} onChange={e => setForm({ ...form, responseMinutes: Number(e.target.value) })} />
                </div>
                <div>
                  <label style={labelS}>Tempo Risoluzione (minuti) *</label>
                  <Input style={inputS} type="number" min={1} value={form.resolveMinutes} onChange={e => setForm({ ...form, resolveMinutes: Number(e.target.value) })} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
                <div>
                  <label style={labelS}>Timezone</label>
                  <Input style={inputS} value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 2 }}>
                  <button onClick={() => setForm({ ...form, businessHours: !form.businessHours })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                    {form.businessHours
                      ? <ToggleRight size={26} color="var(--color-brand)" />
                      : <ToggleLeft size={26} color="#cbd5e1" />}
                  </button>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>Solo orario lavorativo</span>
                </div>
              </div>

              {/* Preview */}
              <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 14px', fontSize: 'var(--font-size-body)', color: '#0369a1' }}>
                <strong>Anteprima:</strong> {formPreview()} — risposta entro {fmtMinutes(form.responseMinutes)}, risoluzione entro {fmtMinutes(form.resolveMinutes)}
                {form.businessHours ? ' (orario lavorativo)' : ' (24/7)'}
              </div>
            </div>
        </Modal>,
        document.body,
      )}

      {/* ── Delete Confirmation ──────────────────────────────────────────────── */}
      {deleteId && createPortal(
        <Modal
          open
          onClose={() => setDeleteId(null)}
          title="Conferma eliminazione"
          width={400}
          zIndex={9999}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeleteId(null)} style={{ padding: '7px 14px' }}>Annulla</Button>
              <Button onClick={() => void handleDelete()} style={{ background: 'var(--color-danger)' }}>Elimina</Button>
            </>
          }
        >
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: 0 }}>
            Sei sicuro di voler eliminare questa SLA policy? L'azione non e reversibile.
          </p>
        </Modal>,
        document.body,
      )}
    </PageContainer>
  )
}
