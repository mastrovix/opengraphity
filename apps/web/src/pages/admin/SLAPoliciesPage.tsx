import { useId } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { useEnumValues } from '@/hooks/useEnumValues'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { Shield, Plus, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { GET_SLA_POLICIES, GET_TEAMS } from '@/graphql/queries'
import { CREATE_SLA_POLICY, UPDATE_SLA_POLICY, DELETE_SLA_POLICY } from '@/graphql/mutations'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Select } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { Toggle } from '@/components/ui/Toggle'
import { selectS, labelS } from '@/components/ui/styles'
import { useListQueryState } from '@/hooks/useListQueryState'
import { useCrudModal } from '@/hooks/useCrudModal'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'

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

const policyToForm = (p: SLAPolicy): FormState => ({
  name: p.name, entityType: p.entityType, priority: p.priority ?? '',
  category: p.category ?? '', teamId: p.teamId ?? '',
  responseMinutes: p.responseMinutes, resolveMinutes: p.resolveMinutes,
  businessHours: p.businessHours, timezone: p.timezone,
})

import { ITIL_ENTITY_TYPES as ENTITY_TYPES } from '@/constants'
import { lookupOrError, palette } from '@/lib/tokens'

const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'Service Request',
}

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
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { values: PRIORITIES } = useEnumValues('incident', 'priority')
  const { values: CATEGORIES } = useEnumValues('incident', 'category')
  const list  = useListQueryState()
  const modal = useCrudModal<SLAPolicy, FormState>(EMPTY_FORM, policyToForm)
  const { draft: form, patch } = modal

  const { data, loading, refetch } = useQuery<{ slaPolicies: SLAPolicy[] }>(GET_SLA_POLICIES, { variables: list.variables })
  const { data: teamsData }           = useQuery<{ teams: Team[] }>(GET_TEAMS)
  const policies: SLAPolicy[]        = data?.slaPolicies ?? []
  const teams: Team[]                 = teamsData?.teams ?? []

  // `refetch()` of the ACTIVE query keeps its sort/filter variables; a
  // `refetchQueries: [{ query }]` without variables would fill another cache
  // entry and leave the visible list stale (E-08). Errors are toasted by the
  // handlers below (they need the await for the success message).
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const afterWrite = { onCompleted: () => { void refetch() } }
  const [createPolicy] = useMutation(CREATE_SLA_POLICY, afterWrite)
  const [updatePolicy] = useMutation(UPDATE_SLA_POLICY, afterWrite)
  const [deletePolicy] = useMutation(DELETE_SLA_POLICY, afterWrite)

  // Group by entity type
  const grouped = ENTITY_TYPES.reduce<Record<string, SLAPolicy[]>>((acc, et) => {
    const items = policies.filter(p => p.entityType === et)
    if (items.length) acc[et] = items
    return acc
  }, {})

  async function handleSave() {
    if (!form.name.trim()) { toast.error(t('toast.sla.nameRequired')); return }
    const common = {
      name: form.name.trim(),
      priority: form.priority || null, category: form.category || null,
      teamId: form.teamId || null,
      responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
      businessHours: form.businessHours, timezone: form.timezone,
    }
    try {
      if (modal.editing) {
        await updatePolicy({ variables: { id: modal.editing.id, input: common } })
        toast.success(t('toast.sla.updated'))
      } else {
        await createPolicy({ variables: { input: { ...common, entityType: form.entityType } } })
        toast.success(t('toast.sla.created'))
      }
      modal.close()
    } catch (e: unknown) { toast.error(errorMessage(e)) }
  }

  async function handleDelete(p: SLAPolicy) {
    const ok = await confirm({ title: t('admin.sla.deleteTitle'), body: p.name, danger: true })
    if (!ok) return
    try {
      await deletePolicy({ variables: { id: p.id } })
      toast.success(t('toast.sla.deleted'))
    } catch (e: unknown) { toast.error(errorMessage(e)) }
  }

  async function handleToggle(p: SLAPolicy) {
    try {
      await updatePolicy({ variables: { id: p.id, input: { enabled: !p.enabled } } })
      toast.success(p.enabled ? t('toast.sla.disabled') : t('toast.sla.enabled'))
    } catch (e: unknown) { toast.error(errorMessage(e)) }
  }

  const policyColumns: ColumnDef<SLAPolicy>[] = [
    { key: 'name', label: 'Nome', sortable: true, render: (_v, row) => (
      <div>
        <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{row.name}</div>
        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)', marginTop: 2, fontStyle: 'italic' }}>{applicabilityText(row)}</div>
      </div>
    ) },
    { key: 'priority', label: 'Priorita', sortable: true, render: (v) => v ? <Pill bg={palette.warning.tint} color={palette.warning.strong} radius={10}>{String(v)}</Pill> : <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>Tutte</span> },
    { key: 'category', label: 'Categoria', sortable: true, render: (v) => v ? <Pill bg={palette.info.tint} color={palette.info.text} radius={10}>{String(v)}</Pill> : <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>Tutte</span> },
    { key: 'teamName', label: 'Team', sortable: true, render: (v) => <span style={{ color: v ? 'var(--color-slate-dark)' : 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{v ? String(v) : 'Tutti'}</span> },
    { key: 'responseMinutes', label: 'Risposta', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v))}</span> },
    { key: 'resolveMinutes', label: 'Risoluzione', sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v))}</span> },
    { key: 'businessHours', label: 'Business Hours', sortable: true, render: (v) => <Pill bg={v ? palette.success.tint : 'var(--color-border-light)'} color={v ? palette.success.text : 'var(--color-slate)'} radius={10}>{v ? 'Si' : 'No'}</Pill> },
    { key: 'enabled', label: 'Attiva', sortable: true, render: (_v, row) => (
      <Toggle checked={row.enabled} onChange={() => void handleToggle(row)} label={t('admin.sla.toggleLabel', { name: row.name })} />
    ) },
    { key: 'id', label: 'Azioni', sortable: true, render: (_v, row) => (
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <Button variant="ghost" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => modal.openEdit(row)} style={{ padding: 4 }}><Pencil size={15} aria-hidden="true" color="var(--color-slate)" /></Button>
        <Button variant="ghost" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => void handleDelete(row)} style={{ padding: 4 }}><Trash2 size={15} aria-hidden="true" color="var(--color-danger)" /></Button>
      </div>
    ) },
  ]

  // ── Preview text for modal form ───────────────────────────────────────────
  function formPreview(): string {
    const parts: string[] = [lookupOrError(ENTITY_LABELS, form.entityType, 'ENTITY_LABELS', form.entityType)]
    if (form.priority) parts.push(`priorita ${form.priority}`)
    if (form.category) parts.push(`categoria ${form.category}`)
    const team = teams.find(tm => tm.id === form.teamId)
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
        <Button icon={<Plus size={15} aria-hidden="true" />} onClick={modal.openCreate}>Nuova Policy</Button>
      </div>

      {!loading && policies.length === 0 && (
        <EmptyState
          icon={<Shield size={32} color="var(--color-slate-light)" />}
          title="Nessuna SLA policy configurata"
          description="Crea la prima policy per definire i tempi di risposta e risoluzione."
        />
      )}

      <FilterBuilder fields={SLA_FILTER_FIELDS} onApply={list.setFilterGroup} />

      {Object.entries(grouped).map(([entityType, items]) => (
        <div key={entityType} style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 8, textTransform: 'capitalize' }}>
            {ENTITY_LABELS[entityType]}
          </h3>
          <SortableFilterTable<SLAPolicy>
            onSort={list.handleSort}
            sortField={list.sortField}
            sortDir={list.sortDir}
            columns={policyColumns}
            data={items}
            loading={false}
            label={`SLA Policies — ${ENTITY_LABELS[entityType]}`}
          />
        </div>
      ))}

      {/* ── Create / Edit Modal ──────────────────────────────────────────────── */}
      <Modal
        open={modal.open}
        onClose={modal.close}
        title={modal.editing ? 'Modifica Policy' : 'Nuova SLA Policy'}
        width={560}
        zIndex={9000}
        closeOnOverlay={false}
        footer={
          <>
            <Button variant="secondary" size="xs" onClick={modal.close}>{t('common.cancel')}</Button>
            <Button onClick={() => void handleSave()}>{modal.editing ? t('common.save') : t('common.create')}</Button>
          </>
        }
      >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label htmlFor={fid('name')} style={labelS}>Nome *</label>
              <Input id={fid('name')} value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="es. SLA Critical Incident" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label htmlFor={fid('entity-type')} style={labelS}>Tipo Entita *</label>
                <Select id={fid('entity-type')} style={selectS} value={form.entityType} onChange={e => patch({ entityType: e.target.value })} disabled={modal.isEditing}>
                  {ENTITY_TYPES.map(et => <option key={et} value={et}>{ENTITY_LABELS[et]}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor={fid('priority')} style={labelS}>Priorita</label>
                <Select id={fid('priority')} style={selectS} value={form.priority} onChange={e => patch({ priority: e.target.value })}>
                  <option value="">Tutte</option>
                  {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                </Select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label htmlFor={fid('category')} style={labelS}>Categoria</label>
                <Select id={fid('category')} style={selectS} value={form.category} onChange={e => patch({ category: e.target.value })}>
                  <option value="">Tutte</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor={fid('team')} style={labelS}>Team</label>
                <Select id={fid('team')} style={selectS} value={form.teamId} onChange={e => patch({ teamId: e.target.value })}>
                  <option value="">Tutti</option>
                  {teams.map(tm => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                </Select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label htmlFor={fid('response-minutes')} style={labelS}>Tempo Risposta (minuti) *</label>
                <Input id={fid('response-minutes')} type="number" min={1} value={form.responseMinutes} onChange={e => patch({ responseMinutes: Number(e.target.value) })} />
              </div>
              <div>
                <label htmlFor={fid('resolve-minutes')} style={labelS}>Tempo Risoluzione (minuti) *</label>
                <Input id={fid('resolve-minutes')} type="number" min={1} value={form.resolveMinutes} onChange={e => patch({ resolveMinutes: Number(e.target.value) })} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
              <div>
                <label htmlFor={fid('timezone')} style={labelS}>Timezone</label>
                <Input id={fid('timezone')} value={form.timezone} onChange={e => patch({ timezone: e.target.value })} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 2 }}>
                <Toggle checked={form.businessHours} onChange={v => patch({ businessHours: v })} label={t('admin.sla.businessHoursLabel')} />
                <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{t('admin.sla.businessHoursLabel')}</span>
              </div>
            </div>

            {/* Preview */}
            <div style={{ background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 'var(--font-size-body)', color: 'var(--accent-hover)' }}>
              <strong>Anteprima:</strong> {formPreview()} — risposta entro {fmtMinutes(form.responseMinutes)}, risoluzione entro {fmtMinutes(form.resolveMinutes)}
              {form.businessHours ? ' (orario lavorativo)' : ' (24/7)'}
            </div>
          </div>
      </Modal>
    </PageContainer>
  )
}
