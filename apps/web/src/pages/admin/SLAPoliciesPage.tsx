import { useId } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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

const slaFilterFields = (t: TFunction): FieldConfig[] => [
  { key: 'entityType', label: t('admin.sla.entityType'), type: 'enum', options: [
    { value: 'incident', label: 'Incident' }, { value: 'change', label: 'Change' },
    { value: 'problem', label: 'Problem' }, { value: 'service_request', label: 'Service Request' },
  ]},
  { key: 'priority', label: t('admin.sla.priority'), type: 'enum', options: [
    { value: 'critical', label: 'Critical' }, { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' },
  ]},
  { key: 'category', label: t('admin.sla.category'), type: 'enum', options: [
    { value: 'hardware', label: 'Hardware' }, { value: 'software', label: 'Software' },
    { value: 'network', label: 'Network' }, { value: 'access', label: 'Access' },
    { value: 'security', label: 'Security' }, { value: 'other', label: 'Other' },
  ]},
  { key: 'enabled', label: t('admin.sla.enabled'), type: 'enum', options: [
    { value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') },
  ]},
  { key: 'name', label: t('common.name'), type: 'text' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Le unita (min / h / g) sono ABBREVIAZIONI a schermo: vengono dalle chiavi,
 * perche «gg» in inglese e «d». Il resto e aritmetica.
 */
function fmtMinutes(m: number, t: TFunction): string {
  const u = (k: string, n: number) => t(`admin.sla.unit.${k}`, { count: n })
  if (m < 60) return u('minutes', m)
  if (m < 1440) return m % 60 === 0 ? u('hours', m / 60) : `${u('hours', Math.floor(m / 60))} ${u('minutes', m % 60)}`
  const d = m / 1440
  return d === Math.floor(d) ? u('days', d) : `${u('days', Math.floor(d))} ${fmtMinutes(m % 1440, t)}`
}

/** La frase «si applica a …» si compone di frammenti tradotti, non di pezzi cuciti. */
function applicabilityText(p: SLAPolicy, t: TFunction): string {
  const scope = scopeParts(p.priority, p.category, p.teamName, t)
  return scope.length === 0
    ? t('admin.sla.appliesToAll',   { entity: entityName(p.entityType) })
    : t('admin.sla.appliesToSome',  { entity: entityName(p.entityType), scope: scope.join(', ') })
}

const entityName = (et: string) => lookupOrError(ENTITY_LABELS, et, 'ENTITY_LABELS', et)

function scopeParts(priority: string | null, category: string | null, teamName: string | null, t: TFunction): string[] {
  const parts: string[] = []
  if (priority) parts.push(t('admin.sla.scopePriority', { value: priority }))
  if (category) parts.push(t('admin.sla.scopeCategory', { value: category }))
  if (teamName) parts.push(t('admin.sla.scopeTeam',     { value: teamName }))
  return parts
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SLAPoliciesPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const list  = useListQueryState()
  const modal = useCrudModal<SLAPolicy, FormState>(EMPTY_FORM, policyToForm)
  const { draft: form, patch } = modal
  /**
   * IL CAMPO CHE IL MOTORE CONFRONTA, non quello che l'etichetta prometteva.
   *
   * `SLAPolicyNode.priority` riceve, per un incident, la **severità**
   * (`resolvePolicy(…, severity)` la passa come argomento `priority` del
   * selettore); per problem e service request riceve la priorità. La tendina
   * leggeva invece `incident.priority` dal metamodello — un campo che non
   * esiste — quindi era **vuota**: su questa pagina non si poteva scrivere
   * nessuna policy per severità. Trovato aprendo la pagina su un tenant vero.
   *
   * E leggeva sempre `'incident'`, anche con «Problem» scelto: le categorie
   * offerte erano quelle degli incident.
   */
  const campoAmbito = form.entityType === 'incident' ? 'severity' : 'priority'
  const { values: PRIORITIES } = useEnumValues(form.entityType, campoAmbito)
  const { values: CATEGORIES } = useEnumValues(form.entityType, 'category')

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
    { key: 'name', label: t('common.name'), sortable: true, render: (_v, row) => (
      <div>
        <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{row.name}</div>
        <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate)', marginTop: 2, fontStyle: 'italic' }}>{applicabilityText(row, t)}</div>
      </div>
    ) },
    { key: 'priority', label: t('admin.sla.scopeField'), sortable: true, render: (v) => v ? <Pill bg={palette.warning.tint} color={palette.warning.strong} radius={10}>{String(v)}</Pill> : <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{t('admin.sla.anyScope')}</span> },
    { key: 'category', label: t('pages.serviceCatalogAdmin.category'), sortable: true, render: (v) => v ? <Pill bg={palette.info.tint} color={palette.info.text} radius={10}>{String(v)}</Pill> : <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{t('common.all')}</span> },
    { key: 'teamName', label: 'Team', sortable: true, render: (v) => <span style={{ color: v ? 'var(--color-slate-dark)' : 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{v ? String(v) : t('common.all')}</span> },
    { key: 'responseMinutes', label: t('admin.sla.response'), sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v), t)}</span> },
    { key: 'resolveMinutes', label: t('admin.sla.resolution'), sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v), t)}</span> },
    { key: 'businessHours', label: 'Business Hours', sortable: true, render: (v) => <Pill bg={v ? palette.success.tint : 'var(--color-border-light)'} color={v ? palette.success.text : 'var(--color-slate)'} radius={10}>{v ? t('common.yes') : t('common.no')}</Pill> },
    { key: 'enabled', label: t('admin.rules.active'), sortable: true, render: (_v, row) => (
      <Toggle checked={row.enabled} onChange={() => void handleToggle(row)} label={t('admin.sla.toggleLabel', { name: row.name })} />
    ) },
    { key: 'id', label: t('common.actions'), sortable: true, render: (_v, row) => (
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <Button variant="ghost" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => modal.openEdit(row)} style={{ padding: 4 }}><Pencil size={15} aria-hidden="true" color="var(--color-slate)" /></Button>
        <Button variant="ghost" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => void handleDelete(row)} style={{ padding: 4 }}><Trash2 size={15} aria-hidden="true" color="var(--color-danger)" /></Button>
      </div>
    ) },
  ]

  // ── Preview text for modal form ───────────────────────────────────────────
  function formPreview(): string {
    const team = teams.find(tm => tm.id === form.teamId)
    const scope = scopeParts(form.priority, form.category, team?.name ?? null, t)
    return scope.length === 0
      ? t('admin.sla.previewAll',  { entity: entityName(form.entityType) })
      : t('admin.sla.previewSome', { entity: entityName(form.entityType), scope: scope.join(', ') })
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Shield size={22} color="var(--color-icon-accent)" />}>{t('sidebar.slaPolicies')}</PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${policies.length} policy`}
          </p>
        </div>
        <Button icon={<Plus size={15} aria-hidden="true" />} onClick={modal.openCreate}>{t('pages.slaPolicies.newPolicy')}</Button>
      </div>

      {!loading && policies.length === 0 && (
        <EmptyState
          icon={<Shield size={32} color="var(--color-slate-light)" />}
          title={t('pages.slaPolicies.emptyTitle')}
          description={t('pages.slaPolicies.emptyDescription')}
        />
      )}

      <FilterBuilder fields={slaFilterFields(t)} onApply={list.setFilterGroup} />

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
            label={t('admin.sla.tableLabel', { entity: ENTITY_LABELS[entityType] })}
          />
        </div>
      ))}

      {/* ── Create / Edit Modal ──────────────────────────────────────────────── */}
      <Modal
        open={modal.open}
        onClose={modal.close}
        title={t(modal.editing ? 'pages.slaPolicies.editPolicy' : 'pages.slaPolicies.newPolicy')}
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
              <label htmlFor={fid('name')} style={labelS}>{t('pages.slaReport.nameRequired')}</label>
              <Input id={fid('name')} value={form.name} onChange={e => patch({ name: e.target.value })} placeholder={t('pages.slaPolicies.namePlaceholder')} />
            </div>

            <div className="og-pair">
              <div>
                <label htmlFor={fid('entity-type')} style={labelS}>{t('admin.sla.entityType')} *</label>
                <Select id={fid('entity-type')} style={selectS} value={form.entityType} onChange={e => patch({ entityType: e.target.value })} disabled={modal.isEditing}>
                  {ENTITY_TYPES.map(et => <option key={et} value={et}>{ENTITY_LABELS[et]}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor={fid('priority')} style={labelS}>{t('admin.sla.scopeField')}</label>
                <Select id={fid('priority')} style={selectS} value={form.priority} onChange={e => patch({ priority: e.target.value })} aria-describedby={fid('scope-hint')}>
                  <option value="">{t('admin.sla.anyScope')}</option>
                  {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                </Select>
                <p id={fid('scope-hint')} style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
                  {t(form.entityType === 'incident' ? 'admin.sla.scopeHintIncident' : 'admin.sla.scopeHintOther')}
                </p>
              </div>
            </div>

            <div className="og-pair">
              <div>
                <label htmlFor={fid('category')} style={labelS}>{t('admin.sla.category')}</label>
                <Select id={fid('category')} style={selectS} value={form.category} onChange={e => patch({ category: e.target.value })}>
                  <option value="">{t('admin.sla.anyScope')}</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor={fid('team')} style={labelS}>{t('admin.sla.team')}</label>
                <Select id={fid('team')} style={selectS} value={form.teamId} onChange={e => patch({ teamId: e.target.value })}>
                  <option value="">{t('admin.sla.anyTeam')}</option>
                  {teams.map(tm => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                </Select>
              </div>
            </div>

            <div className="og-pair">
              <div>
                <label htmlFor={fid('response-minutes')} style={labelS}>{t('pages.slaPolicies.responseMinutes')}</label>
                <Input id={fid('response-minutes')} type="number" min={1} value={form.responseMinutes} onChange={e => patch({ responseMinutes: Number(e.target.value) })} />
              </div>
              <div>
                <label htmlFor={fid('resolve-minutes')} style={labelS}>{t('pages.slaPolicies.resolveMinutes')}</label>
                <Input id={fid('resolve-minutes')} type="number" min={1} value={form.resolveMinutes} onChange={e => patch({ resolveMinutes: Number(e.target.value) })} />
              </div>
            </div>

            <div className="og-pair" style={{ alignItems: 'end' }}>
              <div>
                <label htmlFor={fid('timezone')} style={labelS}>{t('pages.slaPolicies.timezone')}</label>
                <Input id={fid('timezone')} value={form.timezone} onChange={e => patch({ timezone: e.target.value })} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 2 }}>
                <Toggle checked={form.businessHours} onChange={v => patch({ businessHours: v })} label={t('admin.sla.businessHoursLabel')} />
                <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{t('admin.sla.businessHoursLabel')}</span>
              </div>
            </div>

            {/* Preview */}
            <div style={{ background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 'var(--font-size-body)', color: 'var(--accent-hover)' }}>
              <strong>{t('admin.sla.previewLabel')}</strong> {formPreview()} — {t('admin.sla.previewTimes', { response: fmtMinutes(form.responseMinutes, t), resolve: fmtMinutes(form.resolveMinutes, t) })}
              {form.businessHours ? ' (orario lavorativo)' : ' (24/7)'}
            </div>
          </div>
      </Modal>
    </PageContainer>
  )
}
